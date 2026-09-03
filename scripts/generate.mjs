#!/usr/bin/env node
// Commit-Driven Client Portal — single-pass generator.
// Pipeline: git log -> parse -> filter(client-facing) -> translate -> static files.
// No database, no server, no persistent state. Safe to run in a CI step.

import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readGitLog, parseCommit, classify } from './lib/parse-commits.mjs';
import { translate, translateWithAI } from './lib/translate.mjs';
import {
  renderJSON, renderHTML, renderAtom, renderJsonFeed, collapseItems, assignEntryIds,
  renderProfilesIndex,
} from './lib/render.mjs';
import { auditPublishable, formatViolations } from './lib/guard.mjs';
import { loadImageDataUri } from './lib/media.mjs';
import { VOCAB_PACKS, mergeVocabPacks } from './lib/vocab.mjs';
import { buildManifest, verifyManifest } from './lib/manifest.mjs';
import { diagnose, formatReport } from './lib/doctor.mjs';
import { recentItems, renderEmailHtml, renderUpdateMarkdown, renderEmbed } from './lib/digest.mjs';
import { loadCache, saveCache, cacheKey } from './lib/cache.mjs';
import { launchGui } from './gui.mjs';
import { runMcp } from './lib/mcp.mjs';

// Detect single-executable mode (commitport.exe, built via Node SEA) FIRST:
// import.meta.url is undefined inside a SEA, so anything deriving paths from it
// must be guarded. createRequire works off the binary path and resolves the
// node:sea builtin in both modes; isSea() is false for a normal `node` run.
const __require = createRequire(process.execPath);
const SEA = (() => {
  try {
    const m = __require('node:sea');
    return m.isSea() ? m : null;
  } catch {
    return null;
  }
})();
// Base for config, output, and the target repo: the user's current directory
// when packaged (the source tree doesn't exist there), the package root for a
// normal run. The fileURLToPath() branch is never evaluated under SEA.
const ROOT = SEA ? process.cwd() : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = ROOT;
// Read an embedded text asset when packaged, else the committed file on disk.
function readAsset(name, diskRel) {
  return SEA ? SEA.getAsset(name, 'utf8') : readFileSync(resolve(ROOT, diskRel), 'utf8');
}

export function parseArgs(argv) {
  const args = { config: SEA ? 'portal.config.json' : 'config/portal.config.json', out: 'public', ai: false, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--ai') args.ai = true;
    else if (a === '--watch') args.watch = true;
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--after') args.after = argv[++i];
    else if (a === '--before') args.before = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
  }
  return args;
}

function loadConfig(path) {
  const full = resolve(BASE, path);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    // Packaged: fall back to the embedded starter config so `commitport.exe`
    // works in a repo even before the user runs `commitport.exe init`.
    if (SEA) {
      try {
        return JSON.parse(SEA.getAsset('portal.config.json', 'utf8'));
      } catch {
        /* fall through to the actionable error */
      }
    }
    throw new Error(`Could not load config at ${full}: ${err.message}`);
  }
}

// Starter-config presets for common setups, applied on top of the default by
// `commitport init --template <name>`. Each takes the parsed config and tunes
// it. Pure + exported for testing.
const CONFIG_TEMPLATES = {
  agency: (c) => {
    c.site.poweredBy = false; // white-label
    c.voice = 'we';
    c.groupByMessage = true;
    return c;
  },
  freelancer: (c) => {
    c.voice = 'we'; // personal, first-person
    return c;
  },
  changelog: (c) => {
    c.includeTypes = ['feat', 'fix', 'perf']; // publish by Conventional Commit type
    return c;
  },
};

/** Apply a named template to the starter-config TEXT; unknown name is a no-op. */
export function applyTemplate(configText, name) {
  if (!name) return configText;
  const fn = CONFIG_TEMPLATES[name];
  if (!fn) {
    console.warn(
      `init: unknown template "${name}" (available: ${Object.keys(CONFIG_TEMPLATES).join(', ')}) — using the default.`
    );
    return configText;
  }
  return JSON.stringify(fn(JSON.parse(configText)), null, 2) + '\n';
}

// `commitport init [--template <name>]` — drop a starter portal.config.json into
// the current directory so a buyer can edit it and run `commitport build`.
function initConfig(template) {
  const dest = resolve(BASE, 'portal.config.json');
  if (existsSync(dest)) {
    console.log(`portal.config.json already exists at ${dest} — leaving it untouched.`);
    return;
  }
  const text = applyTemplate(readAsset('portal.config.json', 'config/portal.config.json'), template);
  writeFileSync(dest, text);
  console.log(`Wrote ${dest}${template ? ` (template: ${template})` : ''}\nEdit it, then run:  commitport build`);
}

// The starter config text (embedded asset when packaged, else on disk) — used by
// the GUI's "Create config" button to scaffold into the user's chosen folder.
export function starterConfig() {
  return readAsset('portal.config.json', 'config/portal.config.json');
}

// Fail fast with actionable messages instead of crashing mid-pipeline (or
// worse, silently misbehaving) on a malformed config.
function validateConfig(config) {
  const errors = [];
  if (!config.site || typeof config.site.title !== 'string') {
    errors.push('site.title must be a string');
  }
  if (config.site?.logo !== undefined && typeof config.site.logo !== 'string') {
    errors.push('site.logo must be a string path to a repo-relative image');
  }
  if (config.site?.lang !== undefined && typeof config.site.lang !== 'string') {
    errors.push('site.lang must be a string (BCP-47 language tag, e.g. "en" or "de")');
  }
  if (config.publishMode && !['gitmoji', 'explicit'].includes(config.publishMode)) {
    errors.push(`publishMode must be "gitmoji" or "explicit", got "${config.publishMode}"`);
  }
  if (config.voice && !['impersonal', 'we'].includes(config.voice)) {
    errors.push(`voice must be "impersonal" or "we", got "${config.voice}"`);
  }
  if (config.order && !['newest-first', 'oldest-first'].includes(config.order)) {
    errors.push(`order must be "newest-first" or "oldest-first", got "${config.order}"`);
  }
  if (config.vocabPacks !== undefined) {
    if (!Array.isArray(config.vocabPacks)) {
      errors.push('vocabPacks must be an array of pack names');
    } else {
      for (const p of config.vocabPacks) {
        if (typeof p !== 'string') errors.push('vocabPacks entries must be strings');
        else if (!VOCAB_PACKS[p]) {
          errors.push(`unknown vocab pack "${p}" (available: ${Object.keys(VOCAB_PACKS).join(', ')})`);
        }
      }
    }
  }
  if (
    config.media?.maxBytes !== undefined &&
    (typeof config.media.maxBytes !== 'number' || !(config.media.maxBytes > 0))
  ) {
    errors.push('media.maxBytes must be a positive number of bytes');
  }
  if (config.manifest !== undefined && typeof config.manifest !== 'boolean') {
    errors.push('manifest must be true or false');
  }
  if (config.emailDigest !== undefined && typeof config.emailDigest !== 'boolean') {
    errors.push('emailDigest must be true or false');
  }
  if (config.embed !== undefined && typeof config.embed !== 'boolean') {
    errors.push('embed must be true or false');
  }
  if (config.aiCache !== undefined && typeof config.aiCache !== 'boolean') {
    errors.push('aiCache must be true or false');
  }
  if (config.profiles !== undefined) {
    if (!Array.isArray(config.profiles)) {
      errors.push('profiles must be an array of { name?, out, scopes } objects');
    } else {
      config.profiles.forEach((p, i) => {
        if (!p || typeof p !== 'object') {
          errors.push(`profiles[${i}] must be an object`);
          return;
        }
        if (typeof p.out !== 'string' || !p.out) {
          errors.push(`profiles[${i}].out must be a non-empty output-subfolder name`);
        }
        if (!Array.isArray(p.scopes) || !p.scopes.length) {
          errors.push(`profiles[${i}].scopes must be a non-empty array of client scope names`);
        }
      });
    }
  }
  if (config.guard?.allow !== undefined && !Array.isArray(config.guard.allow)) {
    errors.push('guard.allow must be an array of regex strings');
  } else {
    for (const p of config.guard?.allow ?? []) {
      if (typeof p !== 'string') {
        errors.push(`guard.allow entries must be strings, got ${typeof p}`);
        continue;
      }
      try {
        new RegExp(p, 'i');
      } catch (e) {
        errors.push(`guard.allow contains an invalid regex "${p}": ${e.message}`);
      }
    }
  }
  if (config.guard?.deny !== undefined && !Array.isArray(config.guard.deny)) {
    errors.push('guard.deny must be an array of regex strings or {name, pattern} objects');
  } else {
    for (const p of config.guard?.deny ?? []) {
      const pattern = typeof p === 'string' ? p : p?.pattern;
      if (typeof pattern !== 'string') {
        errors.push('guard.deny entries must be regex strings or {name, pattern} objects');
        continue;
      }
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        errors.push(`guard.deny contains an invalid regex "${pattern}": ${e.message}`);
      }
    }
  }
  if (config.site?.url) {
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(config.site.url).protocol);
    } catch {
      /* not a URL */
    }
    if (!ok) errors.push(`site.url must be a valid http(s) URL, got "${config.site.url}"`);
  }
  if (errors.length) {
    throw new Error('Invalid config/portal.config.json:\n  - ' + errors.join('\n  - '));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // `commitport init` scaffolds a config; `commitport build [flags]` is the
  // explicit form, and bare flags still work for backward compatibility.
  if (argv[0] === 'init') {
    const ti = argv.indexOf('--template');
    return initConfig(ti >= 0 ? argv[ti + 1] : null);
  }
  // `commitport mcp` — speak MCP over stdio so AI assistants (Claude Code,
  // Cursor, …) can preview translations, run doctor/stats, build, and verify.
  // Dependencies are injected here so mcp.mjs never imports this module back.
  if (argv[0] === 'mcp') {
    return runMcp({
      version: '2.0.0',
      cwd: process.cwd(),
      existsSync,
      joinPath: join,
      loadConfig,
      validateConfig,
      mergeVocabPacks,
      readGitLog,
      parseCommit,
      classify,
      translate,
      auditPublishable,
      statsReport,
      diagnose,
      formatReport,
      generateAll,
      verifyManifest,
      readAsset,
      recentItems,
      renderUpdateMarkdown,
    });
  }

  // `commitport doctor` explains a setup BEFORE it disappoints someone: why
  // nothing would publish, what the guard would block, what's misconfigured.
  if (argv[0] === 'doctor') {
    const a = parseArgs(argv.slice(1));
    let config;
    try {
      config = loadConfig(a.config);
      validateConfig(config);
    } catch (err) {
      console.error(`FAIL  Config invalid — ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (config.vocabPacks?.length)
      config.dictionary = mergeVocabPacks(config.dictionary, config.vocabPacks);
    const range = {
      sinceTag: a.since ?? config.range?.sinceTag ?? null,
      after: a.after ?? config.range?.after ?? null,
      before: a.before ?? config.range?.before ?? null,
      includePaths: config.includePaths ?? [],
      cwd: a.repo ? resolve(a.repo) : BASE,
    };
    let raw = [];
    try {
      raw = readGitLog(range);
    } catch (err) {
      console.error(`FAIL  Could not read git history — ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const parsed = raw.map(parseCommit);
    const classified = parsed.map((c) => classify(c, config)).filter(Boolean);
    const messages = classified.map((c) => translate(c, config).message);
    const guardHits = auditPublishable(
      messages,
      config.guard?.allow ?? [],
      config.guard?.deny ?? []
    );
    let hasCss = true;
    try {
      readAsset('portal.css', 'assets/portal.css');
    } catch {
      hasCss = false;
    }
    const report = diagnose({
      config,
      parsed,
      classified,
      scanned: raw.length,
      hasCss,
      guardHits,
    });
    console.log(formatReport(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  // `commitport stats [--repo dir]` prints a publish summary without writing.
  if (argv[0] === 'stats') {
    const a = parseArgs(argv.slice(1));
    const config = loadConfig(a.config);
    validateConfig(config);
    const range = {
      sinceTag: a.since ?? config.range?.sinceTag ?? null,
      after: a.after ?? config.range?.after ?? null,
      before: a.before ?? config.range?.before ?? null,
      includePaths: config.includePaths ?? [],
      cwd: a.repo ? resolve(a.repo) : BASE,
    };
    const raw = readGitLog(range);
    const classified = raw.map(parseCommit).map((c) => classify(c, config)).filter(Boolean);
    const s = statsReport(classified, raw.length);
    console.log(`commitport stats: ${s.published} published, ${s.dropped} internal, ${s.scanned} scanned.`);
    for (const [cat, n] of Object.entries(s.byCategory).sort((x, y) => y[1] - x[1])) {
      console.log(`  ${String(n).padStart(4)}  ${cat}`);
    }
    return;
  }
  // `commitport verify [--out dir]` re-checks a built portal against its manifest.
  if (argv[0] === 'verify') {
    const a = parseArgs(argv.slice(1));
    const dir = resolve(BASE, a.out);
    const res = verifyManifest(dir);
    if (res.ok) {
      console.log(`commitport: verified ${res.checked} file(s) in ${dir} — all match manifest.json.`);
      return;
    }
    console.error(`commitport: verification FAILED in ${dir}:`);
    for (const m of res.mismatches) console.error(`  - ${m.name}: ${m.reason}`);
    process.exitCode = 1;
    return;
  }
  // The app window: explicit `gui`, or a double-click on the packaged exe (no
  // args). A normal `node generate.mjs` with no args still means "build".
  if (argv[0] === 'gui' || (SEA && argv.length === 0)) return launchGui();
  const args = parseArgs(argv[0] === 'build' ? argv.slice(1) : argv);
  const opts = {
    repo: args.repo, out: args.out, configPath: args.config, ai: args.ai,
    since: args.since, after: args.after, before: args.before,
  };
  if (args.watch) return runWatch(opts);
  await generateAll(opts);
}

/** Commits explicitly scoped to one of `scopes` — the per-client profile filter. */
export const scopedTo = (commits, scopes) =>
  commits.filter((c) => c.scope && scopes.includes(c.scope));

/** Publish stats for `commitport stats`: totals + a per-category breakdown. */
export function statsReport(classified, scanned) {
  const byCategory = {};
  for (const c of classified) byCategory[c.category] = (byCategory[c.category] || 0) + 1;
  return { scanned, published: classified.length, dropped: scanned - classified.length, byCategory };
}

// Reusable build pipeline — used by the CLI and the app-window GUI. `log`
// captures output (default console.log); returns a summary for the caller.
export async function generatePortal({
  repo, out = 'public', configPath, ai = false, since, after, before, log = console.log, overrides,
} = {}) {
  const config = loadConfig(configPath || (SEA ? 'portal.config.json' : 'config/portal.config.json'));
  validateConfig(config);

  // Per-client profile overrides (set by generateAll): swap in this profile's
  // client scopes and site before the pipeline runs. No-op for a single portal.
  if (overrides?.clientScopes) config.clientScopes = overrides.clientScopes;
  if (overrides?.site) config.site = overrides.site;

  // Extend the translation dictionary with any selected vocab packs (the user's
  // own dictionary still wins) before the pipeline reads config.dictionary.
  if (config.vocabPacks?.length) {
    config.dictionary = mergeVocabPacks(config.dictionary, config.vocabPacks);
  }

  // CLI overrides config; env overrides nothing here (kept explicit).
  const range = {
    sinceTag: since ?? config.range?.sinceTag ?? null,
    after: after ?? config.range?.after ?? null,
    before: before ?? config.range?.before ?? null,
    includePaths: config.includePaths ?? [],
    cwd: repo ? resolve(repo) : BASE,
  };

  // 1. Extract.
  const raw = readGitLog(range);

  // 2. Parse.
  let parsed = raw.map(parseCommit);
  // Per-client profiles: keep ONLY commits scoped to this client (generateAll
  // sets overrides.onlyScopes) so one client never sees another's work — even
  // in gitmoji mode, where a gitmoji would otherwise publish regardless of scope.
  if (overrides?.onlyScopes) {
    parsed = scopedTo(parsed, overrides.onlyScopes);
  }
  // 3. Filter (drop non-client commits silently).
  const classified = parsed.map((c) => classify(c, config)).filter(Boolean);

  // 4. Translate (deterministic by default; optional AI polish).
  // Translation cache (--ai only): skip re-calling the API for commits already
  // translated in a previous build. Keyed by hash + voice; stores only the
  // public message. Persisted to .commitport-cache.json in the repo.
  const aiCacheOn = ai && config.aiCache !== false;
  const cachePath = resolve(range.cwd, '.commitport-cache.json');
  const cache = aiCacheOn ? loadCache(cachePath) : {};
  let cacheDirty = false;
  const translated = [];
  for (const c of classified) {
    // Egress gate: never send a commit whose raw text already looks like it
    // contains a secret to an external API — the final guard below would stop
    // publication, but by then the secret would have left the private boundary.
    const aiSafe =
      ai &&
      auditPublishable([c.description, c.body], config.guard?.allow ?? [], config.guard?.deny ?? [])
        .length === 0;
    let t;
    if (aiSafe) {
      const key = cacheKey(c.hash, config.voice);
      if (aiCacheOn && cache[key]) {
        t = { message: cache[key], source: 'ai-cache' };
      } else {
        // Give the model a changed-files SUMMARY (paths + line counts via
        // `git show --stat`, never the code diff) so it can describe impact even
        // from a terse message — and run the same leak guard on it before it
        // ever leaves the machine, so a secret-shaped path is dropped, not sent.
        let changes = '';
        try {
          changes = execFileSync('git', ['show', '--stat', '--format=', c.hash], {
            cwd: range.cwd,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
          }).trim();
        } catch {
          changes = '';
        }
        if (
          changes &&
          auditPublishable([changes], config.guard?.allow ?? [], config.guard?.deny ?? []).length
        ) {
          changes = '';
        }
        t = await translateWithAI({ ...c, changes }, config, { enableAI: true });
        // Cache only a genuine API result, so a fallback doesn't block a retry.
        if (aiCacheOn && t.source === 'ai') {
          cache[key] = t.message;
          cacheDirty = true;
        }
      }
    } else {
      t = translate(c, config);
    }
    translated.push({ ...c, message: t.message, translationSource: t.source });
  }
  if (aiCacheOn && cacheDirty) saveCache(cachePath, cache);

  // Sort newest-first (timestamp comparison, not string comparison, so mixed
  // timezone offsets order correctly).
  translated.sort((a, b) => Date.parse(b.isoDate) - Date.parse(a.isoDate));

  // Optional grouping: fold same-day, same-message commits into one entry with
  // a count (config.groupByMessage). No-op unless enabled, so default output is
  // unchanged. Done before the guard so each distinct message is audited once.
  const grouped = collapseItems(translated, config);

  // Leak guard: refuse to publish anything that looks like a secret, credential,
  // email, or internal hostname. Failing beats silently shipping it publicly.
  const violations = auditPublishable(
    grouped.map((t) => t.message),
    config.guard?.allow ?? [],
    config.guard?.deny ?? []
  );
  if (violations.length) {
    throw new Error(formatViolations(violations));
  }

  // ISO timestamp without relying on Date.now() semantics for reproducibility:
  // we stamp with the newest commit date if present, else current time.
  const generatedAt = grouped[0]?.isoDate ?? new Date().toISOString();

  // Inline any per-commit screenshots (Image: trailer) as data URIs. After
  // grouping, so only rendered entries load an image; fail-safe per image
  // (a missing / oversized / out-of-repo reference is warned and dropped).
  for (const it of grouped) {
    if (!it.imagePath) continue;
    const uri = loadImageDataUri({
      imagePath: it.imagePath,
      repoDir: range.cwd,
      maxBytes: config.media?.maxBytes,
    });
    if (uri) it.image = uri;
  }

  // White-label: inline the configured brand logo (config.site.logo) the same
  // safe way as screenshots — repo-confined, size-capped, raster-only.
  if (config.site.logo) {
    const logo = loadImageDataUri({
      imagePath: config.site.logo,
      repoDir: range.cwd,
      maxBytes: config.media?.maxBytes,
    });
    if (logo) config.site.logoData = logo;
  }

  // Precompiled Tailwind subset, inlined into the page so the portal makes
  // zero network requests. Committed asset; regenerate with `npm run build:css`
  // after changing classes in render.mjs.
  let cssText;
  try {
    cssText = readAsset('portal.css', 'assets/portal.css');
  } catch {
    throw new Error(
      'assets/portal.css is missing. Regenerate it with `npm run build:css` ' +
        '(requires network once), then re-run the build.'
    );
  }

  // 5. Emit static artifacts.
  const outDir = resolve(BASE, out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'data.json'), renderJSON(grouped, config, generatedAt));
  writeFileSync(resolve(outDir, 'index.html'), renderHTML(grouped, config, generatedAt, cssText));

  // Atom feed — only when the portal's public URL is configured (feed entries
  // need absolute links). validateConfig already vetted the URL shape.
  const hasFeed = Boolean(config.site.url);
  if (hasFeed) {
    writeFileSync(resolve(outDir, 'feed.xml'), renderAtom(grouped, config, generatedAt));
    writeFileSync(resolve(outDir, 'feed.json'), renderJsonFeed(grouped, config, generatedAt));
  }

  // Add .nojekyll so GitHub Pages serves files literally.
  writeFileSync(resolve(outDir, '.nojekyll'), '');

  // Tamper-evident manifest: SHA-256 of each published file, so the portal can
  // be checked later with `commitport verify`. On unless config.manifest:false.
  if (config.manifest !== false) {
    const names = ['index.html', 'data.json', ...(hasFeed ? ['feed.xml', 'feed.json'] : [])];
    writeFileSync(
      resolve(outDir, 'manifest.json'),
      JSON.stringify(buildManifest({ outDir, files: names, generatedAt }), null, 2) + '\n'
    );
  }

  // Shareable update (distribution layer): a ready-to-send email snippet and a
  // copy-paste block for the most recent updates, so the client actually
  // receives progress instead of being expected to check the portal. On unless
  // config.emailDigest:false. Not part of the published portal (not in the
  // manifest) — these are for the agency to send.
  let digestCount = 0;
  if (config.emailDigest !== false) {
    // Assign anchor ids over the FULL list first, then take the recent slice —
    // so the email's deep-links match the portal's <li id> and the feed.
    const digestItems = recentItems(assignEntryIds(grouped));
    digestCount = digestItems.length;
    writeFileSync(resolve(outDir, 'email.html'), renderEmailHtml(digestItems, config, generatedAt));
    writeFileSync(resolve(outDir, 'update.md'), renderUpdateMarkdown(digestItems, config, generatedAt));
  }

  // Opt-in embeddable widget: a self-contained "latest updates" mini-page the
  // agency can iframe into their own site. Off unless config.embed is true.
  if (config.embed === true) {
    writeFileSync(resolve(outDir, 'embed.html'), renderEmbed(assignEntryIds(grouped), config, generatedAt));
  }

  const published = grouped.length;
  const dropped = raw.length - translated.length;
  const groupNote =
    grouped.length < translated.length
      ? ` (grouped from ${translated.length} client commit${translated.length === 1 ? '' : 's'})`
      : '';
  log(`commitport: scanned ${raw.length} commit(s) -> published ${published}${groupNote}, dropped ${dropped} as internal.`);
  // Observability: list exactly what goes public so the user sees what the
  // portal will say. (These strings are public output anyway.)
  for (const t of grouped)
    log(`  publish: ${t.emoji} [${t.category}] ${t.message}${t.count > 1 ? ` ×${t.count}` : ''}`);
  log(`Output written to ${outDir} (index.html, data.json${hasFeed ? ', feed.xml' : ''}).`);
  if (config.emailDigest !== false)
    log(`Shareable update: email.html + update.md (${digestCount} recent update${digestCount === 1 ? '' : 's'} — send it, don't wait for the client to check).`);
  if (ai) log('AI translation: enabled.');
  return {
    published, dropped, scanned: raw.length, outDir,
    indexPath: resolve(outDir, 'index.html'), hasFeed,
    siteTitle: config.site?.title || 'commitport',
  };
}

/**
 * Build one portal, or — when config.profiles is set — a separate portal per
 * client into out/<profile.out>, each filtered to that profile's scopes with
 * its own site overrides. This is how one repo serving several clients emits a
 * branded, client-scoped portal for each. Single-portal configs are unchanged.
 */
export async function generateAll(opts = {}) {
  const config = loadConfig(opts.configPath || (SEA ? 'portal.config.json' : 'config/portal.config.json'));
  validateConfig(config);
  if (!config.profiles?.length) return generatePortal(opts);

  const log = opts.log || console.log;
  const results = [];
  for (const p of config.profiles) {
    const r = await generatePortal({
      ...opts,
      out: `${opts.out || 'public'}/${p.out}`,
      overrides: {
        clientScopes: p.scopes,
        onlyScopes: p.scopes,
        site: { ...config.site, ...(p.site || {}) },
      },
    });
    results.push(r);
    if (p.name) log(`  ↳ client "${p.name}" -> ${r.outDir}`);
  }
  // Each portal lands in its own folder with nothing linking them — write the
  // agency's own index at the output root so the set is navigable.
  try {
    const cssText = readAsset('portal.css', 'assets/portal.css');
    const outRoot = resolve(BASE, opts.out || 'public');
    mkdirSync(outRoot, { recursive: true });
    const listed = config.profiles.map((p, i) => ({
      name: p.name,
      out: p.out,
      published: results[i]?.published ?? 0,
    }));
    const stamp = new Date().toISOString();
    writeFileSync(
      resolve(outRoot, 'index.html'),
      renderProfilesIndex(listed, config, stamp, cssText)
    );
    log(`  ↳ index of ${listed.length} portals -> ${resolve(outRoot, 'index.html')}`);
  } catch (err) {
    log(`  (skipped the portals index: ${err.message})`);
  }
  log(`commitport: built ${results.length} client portals.`);
  return {
    portals: results,
    published: results.reduce((s, r) => s + r.published, 0),
    siteTitle: config.site?.title || 'commitport',
  };
}

/**
 * Files whose changes should trigger a `--watch` rebuild: the config file, and
 * the repo's commit log (`.git/logs/HEAD` moves on every commit / amend / reset
 * / checkout, with `.git/HEAD` as a fallback). Returns absolute paths that
 * currently exist. Exported for testing — the watch loop itself is I/O.
 */
export function watchTargets({ repoDir, configPath }) {
  const targets = [];
  if (configPath) targets.push(resolve(configPath));
  if (repoDir) {
    targets.push(resolve(repoDir, '.git', 'logs', 'HEAD'));
    targets.push(resolve(repoDir, '.git', 'HEAD'));
  }
  return targets.filter((p) => existsSync(p));
}

// `--watch`: build once, then rebuild (debounced) whenever a watched file
// changes. Errors are logged but never kill the watcher, so a bad commit
// message that trips the leak guard just prints and waits for the next change.
async function runWatch(opts) {
  const repoDir = opts.repo ? resolve(opts.repo) : BASE;
  const configPath = resolve(BASE, opts.configPath || (SEA ? 'portal.config.json' : 'config/portal.config.json'));

  const build = async (label) => {
    try {
      await generateAll(opts);
      if (label) console.log(`commitport: ${label}.`);
    } catch (err) {
      console.error(`\nBuild failed: ${err.message}`);
    }
  };
  await build();

  const targets = watchTargets({ repoDir, configPath });
  if (!targets.length) {
    console.warn('watch: nothing to watch (no config or .git found) — exiting.');
    return;
  }
  // Watch the containing directories (atomic renames replace the inode, so
  // watching the file directly misses edits on some platforms) and filter by
  // the target basenames.
  const wanted = new Set(targets.map((t) => t.toLowerCase()));
  const dirs = new Set(targets.map((t) => dirname(t)));
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build('rebuilt'), 200);
  };
  for (const dir of dirs) {
    try {
      watch(dir, (_evt, file) => {
        if (!file) return schedule(); // some platforms omit the filename
        if (wanted.has(resolve(dir, file).toLowerCase())) schedule();
      });
    } catch {
      /* directory not watchable on this platform — skip it */
    }
  }
  console.log(`\ncommitport: watching ${targets.length} path(s) for changes. Press Ctrl-C to stop.`);
}

// Run only as the program entry point (the packaged exe, or `node generate.mjs`),
// never on import — gui.mjs imports generatePortal/starterConfig from here, and
// tests may too, without triggering a build.
const isEntry = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (SEA || isEntry) {
  main().catch((err) => {
    console.error(`\nBuild failed: ${err.message}`);
    process.exit(1);
  });
}
