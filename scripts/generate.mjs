#!/usr/bin/env node
// Commit-Driven Client Portal — single-pass generator.
// Pipeline: git log -> parse -> filter(client-facing) -> translate -> static files.
// No database, no server, no persistent state. Safe to run in a CI step.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readGitLog, parseCommit, classify } from './lib/parse-commits.mjs';
import { translate, translateWithAI } from './lib/translate.mjs';
import { renderJSON, renderHTML, renderAtom } from './lib/render.mjs';
import { auditPublishable, formatViolations } from './lib/guard.mjs';
import { launchGui } from './gui.mjs';

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

function parseArgs(argv) {
  const args = { config: SEA ? 'portal.config.json' : 'config/portal.config.json', out: 'public', ai: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--ai') args.ai = true;
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

// `commitport init` — drop a starter portal.config.json into the current
// directory so a buyer can edit it and run `commitport build`.
function initConfig() {
  const dest = resolve(BASE, 'portal.config.json');
  if (existsSync(dest)) {
    console.log(`portal.config.json already exists at ${dest} — leaving it untouched.`);
    return;
  }
  writeFileSync(dest, readAsset('portal.config.json', 'config/portal.config.json'));
  console.log(`Wrote ${dest}\nEdit it, then run:  commitport build`);
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
  if (config.publishMode && !['gitmoji', 'explicit'].includes(config.publishMode)) {
    errors.push(`publishMode must be "gitmoji" or "explicit", got "${config.publishMode}"`);
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
  if (argv[0] === 'init') return initConfig();
  // The app window: explicit `gui`, or a double-click on the packaged exe (no
  // args). A normal `node generate.mjs` with no args still means "build".
  if (argv[0] === 'gui' || (SEA && argv.length === 0)) return launchGui();
  const args = parseArgs(argv[0] === 'build' ? argv.slice(1) : argv);
  await generatePortal({
    repo: args.repo, out: args.out, configPath: args.config, ai: args.ai,
    since: args.since, after: args.after, before: args.before,
  });
}

// Reusable build pipeline — used by the CLI and the app-window GUI. `log`
// captures output (default console.log); returns a summary for the caller.
export async function generatePortal({
  repo, out = 'public', configPath, ai = false, since, after, before, log = console.log,
} = {}) {
  const config = loadConfig(configPath || (SEA ? 'portal.config.json' : 'config/portal.config.json'));
  validateConfig(config);

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

  // 2. Parse + 3. Filter (drop non-client commits silently).
  const classified = raw
    .map(parseCommit)
    .map((c) => classify(c, config))
    .filter(Boolean);

  // 4. Translate (deterministic by default; optional AI polish).
  const translated = [];
  for (const c of classified) {
    // Egress gate: never send a commit whose raw text already looks like it
    // contains a secret to an external API — the final guard below would stop
    // publication, but by then the secret would have left the private boundary.
    const aiSafe =
      ai &&
      auditPublishable([c.description, c.body], config.guard?.allow ?? []).length === 0;
    const t = aiSafe
      ? await translateWithAI(c, config, { enableAI: true })
      : translate(c, config);
    translated.push({ ...c, message: t.message, translationSource: t.source });
  }

  // Sort newest-first (timestamp comparison, not string comparison, so mixed
  // timezone offsets order correctly).
  translated.sort((a, b) => Date.parse(b.isoDate) - Date.parse(a.isoDate));

  // Leak guard: refuse to publish anything that looks like a secret, credential,
  // email, or internal hostname. Failing beats silently shipping it publicly.
  const violations = auditPublishable(
    translated.map((t) => t.message),
    config.guard?.allow ?? []
  );
  if (violations.length) {
    throw new Error(formatViolations(violations));
  }

  // ISO timestamp without relying on Date.now() semantics for reproducibility:
  // we stamp with the newest commit date if present, else current time.
  const generatedAt = translated[0]?.isoDate ?? new Date().toISOString();

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
  writeFileSync(resolve(outDir, 'data.json'), renderJSON(translated, config, generatedAt));
  writeFileSync(resolve(outDir, 'index.html'), renderHTML(translated, config, generatedAt, cssText));

  // Atom feed — only when the portal's public URL is configured (feed entries
  // need absolute links). validateConfig already vetted the URL shape.
  const hasFeed = Boolean(config.site.url);
  if (hasFeed) {
    writeFileSync(resolve(outDir, 'feed.xml'), renderAtom(translated, config, generatedAt));
  }

  // Add .nojekyll so GitHub Pages serves files literally.
  writeFileSync(resolve(outDir, '.nojekyll'), '');

  const published = translated.length;
  const dropped = raw.length - published;
  log(`commitport: scanned ${raw.length} commit(s) -> published ${published}, dropped ${dropped} as internal.`);
  // Observability: list exactly what goes public so the user sees what the
  // portal will say. (These strings are public output anyway.)
  for (const t of translated) log(`  publish: ${t.emoji} [${t.category}] ${t.message}`);
  log(`Output written to ${outDir} (index.html, data.json${hasFeed ? ', feed.xml' : ''}).`);
  if (ai) log('AI translation: enabled.');
  return {
    published, dropped, scanned: raw.length, outDir,
    indexPath: resolve(outDir, 'index.html'), hasFeed,
    siteTitle: config.site?.title || 'commitport',
  };
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
