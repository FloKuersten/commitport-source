// Test suite — node:test, zero dependencies. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { parseLogOutput, parseCommit, classify } from '../scripts/lib/parse-commits.mjs';
import { translate, aiUserContent } from '../scripts/lib/translate.mjs';
import {
  renderHTML, renderJSON, renderAtom, renderJsonFeed, collapseItems, assignEntryIds,
} from '../scripts/lib/render.mjs';
import { auditPublishable } from '../scripts/lib/guard.mjs';
import { checkCommitMessage } from '../scripts/check-commit-msg.mjs';
import { parseArgs, watchTargets, applyTemplate, scopedTo, statsReport } from '../scripts/generate.mjs';
import { loadImageDataUri } from '../scripts/lib/media.mjs';
import { mergeVocabPacks } from '../scripts/lib/vocab.mjs';
import { buildManifest, verifyManifest } from '../scripts/lib/manifest.mjs';
import { loadCache, saveCache, cacheKey } from '../scripts/lib/cache.mjs';
import { recentItems, renderEmailHtml, renderUpdateMarkdown, renderEmbed } from '../scripts/lib/digest.mjs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const config = JSON.parse(
  readFileSync(new URL('../config/portal.config.json', import.meta.url), 'utf8')
);

const raw = (subject, { trailer = null, body = '', image = null } = {}) => ({
  hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  isoDate: '2026-06-10T12:00:00Z',
  subject,
  clientTrailer: trailer,
  imageTrailer: image,
  body,
});

const pipelineOne = (subject, opts = {}, cfg = config) => {
  const c = classify(parseCommit(raw(subject, opts)), cfg);
  return c ? { ...c, message: translate(c, cfg).message } : null;
};

// ---------- log-output parsing & record integrity ----------

const FS = '\x1f';
// Image trailer sits between Client: and body to mirror the git FORMAT; defaults
// to '' so the existing 5-arg call sites keep producing valid 6-field records.
const record = (hash, date, subject, trailer, body, image = '') =>
  [hash, date, subject, trailer, image, body].join(FS);
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

test('parses NUL-separated records', () => {
  const out =
    record(HASH_A, '2026-06-10T12:00:00+00:00', 'feat: one', '', 'body') +
    '\0' +
    record(HASH_B, '2026-06-09T12:00:00+00:00', 'fix: two', 'Hand-written.', '');
  const recs = parseLogOutput(out);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].subject, 'feat: one');
  assert.equal(recs[1].clientTrailer, 'Hand-written.');
});

test('drops records smuggling extra field separators in the body', () => {
  // An attacker embeds \x1f in the body to shift fields. Field count != 5 -> dropped.
  const smuggled = record(
    HASH_A,
    '2026-06-10T12:00:00+00:00',
    'chore: innocent',
    '',
    `evil${FS}:sparkles: feat: forged entry`
  );
  assert.equal(parseLogOutput(smuggled).length, 0);
});

test('drops records with forged hash or date', () => {
  const badHash = record('not-a-hash', '2026-06-10T12:00:00+00:00', 'feat: x', '', '');
  const badDate = record(HASH_A, 'yesterday-ish', 'feat: x', '', '');
  assert.equal(parseLogOutput(badHash).length, 0);
  assert.equal(parseLogOutput(badDate).length, 0);
});

test('strips control and bidi-override characters from published fields', () => {
  const sneaky = record(
    HASH_A,
    '2026-06-10T12:00:00+00:00',
    'feat: visible\x07‮elbisivni',
    'trailer\x1b[31mred',
    'body⁦text'
  );
  const [r] = parseLogOutput(sneaky);
  assert.equal(r.subject, 'feat: visibleelbisivni');
  assert.equal(r.clientTrailer, 'trailer[31mred');
  assert.equal(r.body, 'bodytext');
});

test('multiple Client trailers: first one wins', () => {
  const r = parseLogOutput(
    record(HASH_A, '2026-06-10T12:00:00+00:00', 'fix: x', 'First.\nSecond.', '')
  )[0];
  assert.equal(r.clientTrailer, 'First.');
});

// ---------- commit parsing ----------

test('parses conventional header with scope and breaking marker', () => {
  const p = parseCommit(raw(':boom: feat(public)!: revamp pricing'));
  assert.equal(p.type, 'feat');
  assert.equal(p.scope, 'public');
  assert.equal(p.breaking, true);
  assert.equal(p.description, 'revamp pricing');
});

test('recognises shortcode and unicode gitmoji equally', () => {
  assert.equal(parseCommit(raw(':sparkles: feat: x')).gitmojiShortcode, ':sparkles:');
  assert.equal(parseCommit(raw('✨ feat: x')).gitmojiUnicode, '✨');
});

test('git-parsed Client trailer becomes the clientMessage', () => {
  const p = parseCommit(raw('fix: internals', { trailer: 'Faster checkout for everyone.' }));
  assert.equal(p.clientMessage, 'Faster checkout for everyone.');
});

test('a "client:" line in prose is NOT a trailer (git decides, not a regex)', () => {
  // Body text mentioning "client:" arrives in the body field, not the trailer
  // field — so it must not force publication.
  const p = parseCommit(raw('chore: notes', { body: 'told the client: nothing yet' }));
  assert.equal(p.clientMessage, null);
});

// ---------- classification ----------

test('drops unmarked internal commits silently', () => {
  assert.equal(pipelineOne('chore: tidy imports'), null);
  assert.equal(pipelineOne('refactor(auth): split module'), null);
});

test('internal scope denylist beats a client gitmoji', () => {
  assert.equal(pipelineOne(':bug: fix(internal): typo in log'), null);
  assert.equal(pipelineOne(':sparkles: feat(deps): shiny dep'), null);
});

test('internal scope beats even a Client trailer (privacy wins)', () => {
  assert.equal(
    pipelineOne('fix(internal): hush', { trailer: 'Please publish me.' }),
    null
  );
});

test('Client trailer force-includes an otherwise internal commit', () => {
  const item = pipelineOne('fix: null ptr', { trailer: 'Notifications are reliable now.' });
  assert.ok(item);
  assert.equal(item.message, 'Notifications are reliable now.');
});

test('client scope includes without a gitmoji', () => {
  const item = pipelineOne('feat(client): add CSV export to reports');
  assert.ok(item);
  assert.equal(item.category, 'New Feature');
});

test('includeTypes publishes commits by conventional type (changelog mode)', () => {
  const cl = { ...config, includeTypes: ['feat', 'fix'] };
  const feat = classify(parseCommit(raw('feat: add CSV export')), cl);
  assert.ok(feat); // plain feat, no gitmoji/scope, now included
  assert.equal(feat.category, 'New Feature'); // from typeMap
  assert.equal(classify(parseCommit(raw('feat(deps): bump eslint')), cl), null); // internal scope still wins
  assert.equal(classify(parseCommit(raw('docs: tweak readme')), cl), null); // type not in includeTypes
});

test('publishMode "explicit": gitmoji alone no longer publishes', () => {
  const explicit = { ...config, publishMode: 'explicit' };
  assert.equal(pipelineOne(':sparkles: feat: add dark mode', {}, explicit), null);
  assert.ok(pipelineOne('feat(client): add dark mode', {}, explicit));
  assert.ok(pipelineOne('fix: x', { trailer: 'Dark mode is here.' }, explicit));
});

test('non-code milestone: a marked empty-commit gitmoji publishes with a Milestone badge', () => {
  const item = pipelineOne(':handshake: chore(client): design sign-off', {
    trailer: 'Your homepage design is approved.',
  });
  assert.ok(item);
  assert.equal(item.category, 'Milestone');
  assert.equal(item.emoji, '🤝');
  assert.equal(item.message, 'Your homepage design is approved.'); // Client: trailer verbatim
});

// ---------- translation ----------

test('maps engineer verbs and jargon to client language', () => {
  const item = pipelineOne(':sparkles: feat: migrate auth module to new JWT standard');
  assert.equal(item.message, 'Upgraded login to new secure sign-in');
});

test('never stacks two verbs and preserves acronym casing', () => {
  const item = pipelineOne('feat(client): add CSV export to the reporting dashboard');
  assert.equal(item.message, 'Added CSV export to the reporting dashboard');
});

test('collapses accidental duplicate words', () => {
  const item = pipelineOne(':lipstick: feat(client): refresh dashboard with responsive layout');
  assert.ok(!/\b(\w+) \1\b/i.test(item.message), item.message);
});

test('phrasal verbs are consumed whole (no "Sped up speed up")', () => {
  // Category verb would otherwise double the leading phrasal verb.
  assert.equal(pipelineOne(':zap: perf(client): speed up search').message, 'Sped up search');
  assert.equal(
    pipelineOne(':sparkles: feat(client): set up onboarding flow').message,
    'Set up onboarding flow'
  );
});

test('aiUserContent adds a changed-files summary only when present, truncated', () => {
  assert.equal(aiUserContent({ type: 'fix', description: 'wip' }), 'fix: wip');
  const withChanges = aiUserContent({
    type: 'fix',
    description: 'wip',
    changes: ' src/login.js | 40 +--\n 1 file changed',
  });
  assert.match(withChanges, /Changed files \(for context\):/);
  assert.match(withChanges, /src\/login\.js/);
  // Bounded so a huge changeset can't bloat the request.
  assert.ok(aiUserContent({ type: 'feat', description: 'x', changes: 'a'.repeat(5000) }).length < 1000);
});

test('voice "we" rewrites deterministic copy in the first person', () => {
  const weCfg = { ...config, voice: 'we' };
  // Same commit, impersonal (default) vs first-person.
  assert.equal(pipelineOne(':bug: fix: resolve race condition').message, 'Resolved reliability issue');
  assert.equal(
    pipelineOne(':bug: fix: resolve race condition', {}, weCfg).message,
    'We resolved reliability issue'
  );
  // Acronyms in the body keep their casing — only the leading verb is lowercased.
  assert.equal(
    pipelineOne('feat(client): add CSV export to the reporting dashboard', {}, weCfg).message,
    'We added CSV export to the reporting dashboard'
  );
});

test('voice "we" leaves a Client: trailer verbatim', () => {
  const weCfg = { ...config, voice: 'we' };
  const item = pipelineOne('fix: x', { trailer: 'Your dashboard is faster.' }, weCfg);
  assert.equal(item.message, 'Your dashboard is faster.');
});

// ---------- vocab packs ----------

test('mergeVocabPacks layers packs under the user dictionary', () => {
  const dict = mergeVocabPacks({ churn: 'KEEP' }, ['saas']);
  assert.equal(dict.tenant, 'account'); // pack term applied
  assert.equal(dict.churn, 'KEEP'); // user's explicit dictionary wins over the pack
});

test('mergeVocabPacks ignores unknown packs and empty input', () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(mergeVocabPacks({ a: 'b' }, ['nope']), { a: 'b' });
    assert.deepEqual(mergeVocabPacks(), {});
  } finally {
    console.warn = origWarn;
  }
});

test('translate applies a vocab pack term once merged', () => {
  const cfg = { ...config, dictionary: mergeVocabPacks(config.dictionary, ['ecommerce']) };
  // "fulfillment" -> "order handling" comes from the ecommerce pack.
  const c = classify(parseCommit(raw(':sparkles: feat(client): improve fulfillment speed')), cfg);
  assert.match(translate(c, cfg).message, /order handling/);
});

// ---------- rendering ----------

const sampleItems = [
  {
    isoDate: '2026-06-10T12:34:56+05:30',
    emoji: '✨',
    category: 'New Feature',
    message: 'Added <script>alert(1)</script> & "quotes"',
  },
];

test('HTML output escapes commit-derived content', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('HTML output carries CSP and referrer meta, and no external URLs or scripts', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '.x{color:red}');
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes('name="referrer" content="no-referrer"'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/src="https?:/i.test(html));
});

test('invalid accent color falls back instead of injecting CSS', () => {
  const evil = { ...config, site: { ...config.site, accent: 'red; } body { display:none' } };
  const html = renderHTML(sampleItems, evil, '2026-06-10T12:00:00Z', '');
  assert.ok(html.includes('--accent: #6366f1;'));
  assert.ok(!html.includes('display:none'));
});

test('refuses CSS containing a style-tag breakout', () => {
  assert.throws(() =>
    renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '</style><script>1</script>')
  );
});

test('JSON output contains no hashes, authors, or sub-day timestamps', () => {
  const json = renderJSON(sampleItems, config, '2026-06-10T12:34:56+05:30');
  assert.ok(!json.includes('deadbeef'));
  assert.ok(!json.includes('author'));
  // Day resolution only — no clock times or timezone offsets anywhere.
  assert.ok(!/\d{2}:\d{2}/.test(json), json);
  const data = JSON.parse(json);
  assert.equal(data.items[0].date, '2026-06-10');
  assert.equal(data.items[0].timestamp, undefined);
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------- per-update permalinks ----------

test('assignEntryIds gives stable, privacy-safe anchors (never the commit hash)', () => {
  const items = [
    { isoDate: '2026-06-10T10:00:00Z', message: 'A', emoji: '✨', category: 'New Feature' },
    { isoDate: '2026-06-10T09:00:00Z', message: 'A', emoji: '✨', category: 'New Feature' },
    { isoDate: '2026-06-10T08:00:00Z', message: 'B', emoji: '🐛', category: 'Fix' },
  ];
  const out = assignEntryIds(items);
  assert.ok(out.every((i) => /^u-[0-9a-f]{16}$/.test(i.id)));
  assert.notEqual(out[0].id, out[1].id); // same day+message disambiguated by occurrence
  assert.notEqual(out[0].id, out[2].id);
  // Deterministic across rebuilds.
  assert.deepEqual(
    assignEntryIds(items).map((i) => i.id),
    out.map((i) => i.id)
  );
});

test('portal entry, data.json id, and Atom deep-link share the same anchor', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  const data = JSON.parse(renderJSON(sampleItems, config, '2026-06-10T12:00:00Z'));
  const xml = renderAtom(sampleItems, config, '2026-06-10T12:00:00Z');
  const id = data.items[0].id;
  assert.match(id, /^u-[0-9a-f]{16}$/);
  assert.ok(html.includes(`id="${id}"`)); // <li id="u-…">
  assert.ok(xml.includes(`#${id}"`)); // <link rel="alternate" …#u-…">
});

test('header shows the count of shipped updates (reinforces delivered value)', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.match(html, new RegExp(`Live progress feed · ${sampleItems.length} update`));
});

test('order: oldest-first reverses the portal reading direction', () => {
  const orderItems = [
    { isoDate: '2026-06-12T10:00:00Z', emoji: '✨', category: 'New Feature', message: 'the newer one' },
    { isoDate: '2026-06-10T10:00:00Z', emoji: '🐛', category: 'Fix', message: 'the older one' },
  ];
  const def = renderHTML(orderItems, config, '2026-06-12T12:00:00Z', '');
  assert.ok(def.indexOf('the newer one') < def.indexOf('the older one')); // newest-first default
  const oldest = renderHTML(orderItems, { ...config, order: 'oldest-first' }, '2026-06-12T12:00:00Z', '');
  assert.ok(oldest.indexOf('the older one') < oldest.indexOf('the newer one'));
});

test('decorative emoji is aria-hidden and lang is configurable', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  // The round emoji badge is decorative — the category text carries the meaning.
  assert.match(html, /<span aria-hidden="true"[^>]*>✨<\/span>/);
  // Default language.
  assert.match(html, /<html lang="en"/);
  // Configurable for non-English portals.
  const de = renderHTML(sampleItems, { ...config, site: { ...config.site, lang: 'de' } }, '2026-06-10T12:00:00Z', '');
  assert.match(de, /<html lang="de"/);
});

test('HTML honors dark mode via compiled CSS, not JS', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.ok(html.includes('name="color-scheme" content="light dark"'));
  assert.ok(html.includes('prefers-color-scheme: dark'));
  assert.ok(!/<script/i.test(html));
});

// ---------- powered-by backlink (growth, opt-out) ----------

test('footer shows a "Built with commitport" backlink by default', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.match(html, /Built with <a href="https:\/\/commitport\.com"[^>]*>commitport<\/a>/);
  // It is a navigable link (href), never a resource load (src) — keeps the
  // zero-network promise of the page intact.
  assert.ok(!/src="https?:/i.test(html));
});

test('site.poweredBy:false removes the commitport backlink (white-label)', () => {
  const cfg = { ...config, site: { ...config.site, poweredBy: false } };
  const html = renderHTML(sampleItems, cfg, '2026-06-10T12:00:00Z', '');
  assert.ok(!html.includes('commitport.com'));
});

test('a configured logo renders as an inline header image (white-label)', () => {
  const cfg = { ...config, site: { ...config.site, logoData: 'data:image/png;base64,BBBB' } };
  const html = renderHTML(sampleItems, cfg, '2026-06-10T12:00:00Z', '');
  assert.match(html, /<header[^>]*>\s*<img src="data:image\/png;base64,BBBB" alt="[^"]+"/);
  assert.ok(!/src="https?:/i.test(html)); // logo is inlined, never an external load
});

const groupItems = [
  { isoDate: '2026-06-10T15:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed a reliability issue' },
  { isoDate: '2026-06-10T11:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed a reliability issue' },
  { isoDate: '2026-06-10T09:00:00Z', emoji: '✨', category: 'New Feature', message: 'Launched the dashboard' },
  { isoDate: '2026-06-09T10:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed a reliability issue' },
];

test('collapseItems is a no-op unless groupByMessage is enabled', () => {
  assert.equal(collapseItems(groupItems), groupItems); // same reference back
  assert.equal(collapseItems(groupItems, {}), groupItems);
  assert.equal(collapseItems(groupItems, { groupByMessage: false }), groupItems);
});

test('collapseItems folds same-day, same-message commits with a count', () => {
  const out = collapseItems(groupItems, { groupByMessage: true });
  // The two June-10 reliability fixes merge; the dashboard (different message)
  // and the June-9 fix (different day) stay separate -> 3 entries.
  assert.equal(out.length, 3);
  const merged = out.find(
    (i) => i.message === 'Fixed a reliability issue' && i.isoDate.startsWith('2026-06-10')
  );
  assert.equal(merged.count, 2);
  // Order preserved (newest-first input) — first occurrence represents the group.
  assert.equal(out[0].isoDate, '2026-06-10T15:00:00Z');
  // Same message on a different day is NOT merged.
  assert.ok(out.some((i) => i.isoDate.startsWith('2026-06-09') && i.count === 1));
  // A lone commit gets count 1.
  assert.equal(out.find((i) => i.category === 'New Feature').count, 1);
});

test('grouped HTML shows a ×N badge; ungrouped output omits it', () => {
  const grouped = collapseItems(groupItems, { groupByMessage: true });
  assert.match(renderHTML(grouped, config, '2026-06-10T12:00:00Z', ''), /×2/);
  // A plain (ungrouped) render never shows a count badge.
  assert.ok(!/×\d/.test(renderHTML(groupItems, config, '2026-06-10T12:00:00Z', '')));
});

test('grouped JSON carries count only when > 1', () => {
  const grouped = collapseItems(groupItems, { groupByMessage: true });
  const data = JSON.parse(renderJSON(grouped, config, '2026-06-10T12:00:00Z'));
  assert.equal(data.items.find((i) => i.count).count, 2);
  // Single-commit entries omit the field entirely (backward-compatible shape).
  assert.ok(
    data.items.some((i) => i.message === 'Launched the dashboard' && i.count === undefined)
  );
});

// ---------- watch mode (helpers) ----------

test('parseArgs recognizes --watch (default off)', () => {
  assert.equal(parseArgs(['--watch']).watch, true);
  assert.equal(parseArgs([]).watch, false);
  assert.equal(parseArgs(['--out', 'x']).watch, false);
});

test('statsReport totals publications, drops, and a per-category breakdown', () => {
  const s = statsReport(
    [{ category: 'New Feature' }, { category: 'Fix' }, { category: 'New Feature' }],
    10
  );
  assert.equal(s.published, 3);
  assert.equal(s.dropped, 7);
  assert.equal(s.scanned, 10);
  assert.equal(s.byCategory['New Feature'], 2);
  assert.equal(s.byCategory.Fix, 1);
});

test('scopedTo keeps only commits in the given client scopes (profile routing)', () => {
  const commits = [
    { scope: 'acme', description: 'a' },
    { scope: 'globex', description: 'b' },
    { scope: null, description: 'c' }, // unscoped -> belongs to no client
    { scope: 'acme', description: 'd' },
  ];
  const acme = scopedTo(commits, ['acme']);
  assert.equal(acme.length, 2);
  assert.ok(acme.every((c) => c.scope === 'acme'));
  assert.equal(scopedTo(commits, ['globex']).length, 1);
  assert.equal(scopedTo(commits, []).length, 0); // no scopes -> nothing
});

test('init templates tune the starter config; unknown/none is a no-op', () => {
  const base = readFileSync(new URL('../config/portal.config.json', import.meta.url), 'utf8');
  const agency = JSON.parse(applyTemplate(base, 'agency'));
  assert.equal(agency.site.poweredBy, false);
  assert.equal(agency.voice, 'we');
  assert.equal(agency.groupByMessage, true);
  assert.deepEqual(JSON.parse(applyTemplate(base, 'changelog')).includeTypes, ['feat', 'fix', 'perf']);
  assert.equal(applyTemplate(base, 'bogus'), base); // unknown -> default
  assert.equal(applyTemplate(base, null), base); // none -> default
});

test('watchTargets returns existing config + git paths, drops a missing repo', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const cfg = fileURLToPath(new URL('../config/portal.config.json', import.meta.url));
  const t = watchTargets({ repoDir: repoRoot, configPath: cfg });
  assert.ok(t.includes(resolve(cfg)));
  assert.ok(t.some((p) => /[\\/]\.git[\\/].*HEAD$/.test(p)));
  // A non-existent repo contributes no git paths; only the real config remains.
  const t2 = watchTargets({ repoDir: resolve(repoRoot, 'definitely-not-a-dir'), configPath: cfg });
  assert.deepEqual(t2, [resolve(cfg)]);
});

// ---------- screenshots (Image: trailer) ----------

test('parses an Image: trailer into imagePath', () => {
  const out = record(HASH_A, '2026-06-10T12:00:00+00:00', 'feat: x', '', 'body', 'docs/shot.png');
  const [rec] = parseLogOutput(out);
  assert.equal(rec.imageTrailer, 'docs/shot.png');
  assert.equal(parseCommit(rec).imagePath, 'docs/shot.png');
});

test('loadImageDataUri inlines an in-repo image and rejects abuse', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cp-media-'));
  const origWarn = console.warn;
  console.warn = () => {}; // rejections warn by design — keep test output clean
  try {
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    writeFileSync(resolve(dir, 'shot.png'), png);
    writeFileSync(resolve(dir, 'note.txt'), 'hi');

    assert.match(
      loadImageDataUri({ imagePath: 'shot.png', repoDir: dir }),
      /^data:image\/png;base64,/
    );
    // absolute path / traversal / wrong type / missing / oversize / no input / no repo
    assert.equal(loadImageDataUri({ imagePath: resolve(dir, 'shot.png'), repoDir: dir }), null);
    assert.equal(loadImageDataUri({ imagePath: '../shot.png', repoDir: dir }), null);
    assert.equal(loadImageDataUri({ imagePath: 'note.txt', repoDir: dir }), null);
    assert.equal(loadImageDataUri({ imagePath: 'missing.png', repoDir: dir }), null);
    assert.equal(loadImageDataUri({ imagePath: 'shot.png', repoDir: dir, maxBytes: 10 }), null);
    assert.equal(loadImageDataUri({ imagePath: '', repoDir: dir }), null);
    assert.equal(loadImageDataUri({ imagePath: 'shot.png' }), null);
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry image renders as an inline data-URI img under a data: CSP', () => {
  const withImg = [{ ...sampleItems[0], image: 'data:image/png;base64,AAAA' }];
  const html = renderHTML(withImg, config, '2026-06-10T12:00:00Z', '');
  assert.match(html, /<img src="data:image\/png;base64,AAAA"/);
  assert.match(html, /img-src data:/); // CSP permits data: images only
  assert.ok(!/src="https?:/i.test(html)); // still zero external loads
  // An entry without an image emits no <img> at all.
  assert.ok(!/<img /.test(renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '')));
});

test('JSON flags hasImage without embedding the bytes', () => {
  const withImg = [{ ...sampleItems[0], image: 'data:image/png;base64,AAAA' }];
  const data = JSON.parse(renderJSON(withImg, config, '2026-06-10T12:00:00Z'));
  assert.equal(data.items[0].hasImage, true);
  assert.ok(!JSON.stringify(data).includes('base64')); // bytes stay out of data.json
});

test('embed.html is a self-contained widget: limited, escaped, deep-linked', () => {
  const items = assignEntryIds([
    { isoDate: '2026-06-20T10:00:00Z', emoji: '✨', category: 'New Feature', message: 'Launched <b>x</b>' },
    { isoDate: '2026-06-19T10:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed y' },
    { isoDate: '2026-06-18T10:00:00Z', emoji: '⚡', category: 'Performance', message: 'Sped up z' },
  ]);
  const html = renderEmbed(items, config, '2026-06-20T00:00:00Z', { limit: 2 });
  assert.ok(html.includes('Launched') && html.includes('Fixed y')); // limit respected
  assert.ok(!html.includes('Sped up z'));
  assert.ok(!html.includes('<b>x</b>')); // escaped
  assert.match(html, /&lt;b&gt;x/);
  assert.ok(!/src=/i.test(html)); // no external resource loads
  assert.ok(!/https?:\/\/(?!example\.com)/i.test(html)); // only the configured portal url
  assert.ok(html.includes(`#${items[0].id}"`)); // deep-links to the portal anchor
});

// ---------- build manifest (verifiable output) ----------

test('buildManifest + verifyManifest detect tampering', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cp-man-'));
  try {
    writeFileSync(resolve(dir, 'index.html'), '<html>a</html>');
    writeFileSync(resolve(dir, 'data.json'), '{"x":1}');
    const man = buildManifest({
      outDir: dir,
      files: ['index.html', 'data.json'],
      generatedAt: '2026-06-10',
    });
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(man));

    let r = verifyManifest(dir);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 2);

    // Tamper one file -> hash mismatch is caught.
    writeFileSync(resolve(dir, 'index.html'), '<html>EVIL</html>');
    r = verifyManifest(dir);
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.some((m) => m.name === 'index.html' && /mismatch/.test(m.reason)));

    // A removed file is reported missing.
    rmSync(resolve(dir, 'data.json'));
    assert.ok(verifyManifest(dir).mismatches.some((m) => m.name === 'data.json' && m.reason === 'missing'));

    // No manifest -> not ok.
    rmSync(resolve(dir, 'manifest.json'));
    assert.equal(verifyManifest(dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyManifest refuses path-y file names in a tampered manifest', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cp-man2-'));
  try {
    writeFileSync(
      resolve(dir, 'manifest.json'),
      JSON.stringify({ tool: 'commitport', files: [{ name: '../secret', sha256: 'x' }] })
    );
    const r = verifyManifest(dir);
    assert.equal(r.ok, false);
    assert.ok(r.mismatches.some((m) => /invalid file name/.test(m.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- --ai translation cache ----------

test('translation cache round-trips, keys on hash+voice, tolerates a bad file', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'cp-cache-'));
  try {
    const p = resolve(dir, '.commitport-cache.json');
    assert.deepEqual(loadCache(p), {}); // missing -> {}
    assert.equal(cacheKey('abc123', 'we'), 'abc123|we');
    assert.equal(cacheKey('abc123'), 'abc123|impersonal'); // default voice
    assert.ok(saveCache(p, { [cacheKey('abc123', 'we')]: 'We shipped it' }));
    assert.equal(loadCache(p)['abc123|we'], 'We shipped it');
    writeFileSync(p, 'not json at all');
    assert.deepEqual(loadCache(p), {}); // malformed -> {}
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- shareable update (email + copy block) ----------

const digestSample = [
  { isoDate: '2026-06-20T10:00:00Z', emoji: '✨', category: 'New Feature', message: 'Launched <b>booking</b>' },
  { isoDate: '2026-06-18T10:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed checkout', count: 2 },
  { isoDate: '2026-06-05T10:00:00Z', emoji: '📝', category: 'Documentation', message: 'Old note (outside window)' },
];

test('recentItems keeps only the last 7 days from the newest item', () => {
  const r = recentItems(digestSample);
  assert.equal(r.length, 2); // 06-20 + 06-18 in; 06-05 out
  assert.ok(r.every((i) => i.isoDate >= '2026-06-14'));
  assert.equal(recentItems([]).length, 0);
});

test('update.md is a clean paste block with title, items, count, and link', () => {
  const md = renderUpdateMarkdown(recentItems(digestSample), config, '2026-06-20T00:00:00Z');
  assert.ok(md.includes(config.site.title));
  assert.match(md, /progress update/);
  assert.match(md, /- ✨ \*\*New Feature\*\* — Launched/);
  assert.match(md, /\(×2\)/); // grouped count carried through
  assert.ok(md.includes(config.site.url)); // full-portal link
});

test('email items deep-link to their portal anchors when ids are present', () => {
  const withIds = assignEntryIds(recentItems(digestSample));
  const html = renderEmailHtml(withIds, config, '2026-06-20T00:00:00Z');
  assert.ok(html.includes(`href="https://example.com/portal/#${withIds[0].id}"`));
  // Without ids (plain items) it degrades to text — no per-item links.
  const plain = renderEmailHtml(recentItems(digestSample), config, '2026-06-20T00:00:00Z');
  assert.ok(!/#u-[0-9a-f]{16}/.test(plain));
});

test('email.html is self-contained and escapes commit content', () => {
  const html = renderEmailHtml(recentItems(digestSample), config, '2026-06-20T00:00:00Z');
  assert.ok(html.includes(config.site.title));
  assert.match(html, /New Feature/);
  // HTML inside a message is escaped, never injected.
  assert.ok(!html.includes('<b>booking</b>'));
  assert.match(html, /&lt;b&gt;booking/);
  // Email-safe + self-contained: no <style> block, no resource loads at all.
  assert.ok(!/<style/i.test(html));
  assert.ok(!/src=/i.test(html));
  // The only external URL is the configured portal link (an href).
  assert.ok(html.includes('href="https://example.com/portal/"'));
});

// ---------- Atom feed ----------

test('Atom feed escapes content, uses day-only dates, never leaks hashes', () => {
  const xml = renderAtom(sampleItems, config, '2026-06-10T12:34:56+05:30');
  assert.ok(xml.includes('&lt;script&gt;')); // message XML-escaped
  assert.ok(!xml.includes('<script>alert'));
  assert.ok(!xml.includes('deadbeef'));
  // Day-resolution: every timestamp is exactly midnight UTC.
  for (const m of xml.matchAll(/<updated>([^<]+)<\/updated>/g)) {
    assert.match(m[1], /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  }
  assert.ok(xml.includes('rel="self"'));
});

test('Atom feed requires a valid http(s) site.url', () => {
  const bad = { ...config, site: { ...config.site, url: 'javascript:alert(1)' } };
  assert.throws(() => renderAtom(sampleItems, bad, '2026-06-10T12:00:00Z'));
});

test('JSON Feed is valid jsonfeed 1.1 — day-dated, anchored, no hashes', () => {
  const raw = renderJsonFeed(sampleItems, config, '2026-06-10T12:34:56+05:30');
  assert.ok(!raw.includes('deadbeef')); // no commit hash leaks
  const feed = JSON.parse(raw);
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.ok(feed.feed_url.endsWith('/feed.json'));
  const it = feed.items[0];
  assert.match(it.id, /^u-[0-9a-f]{16}$/);
  assert.ok(it.url.includes(`#${it.id}`)); // deep-links to the portal anchor
  assert.match(it.date_published, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/); // day resolution only
  assert.ok(Array.isArray(it.tags) && it.tags.length === 1); // category tag
  assert.equal(typeof it.content_text, 'string');
});

test('renderJsonFeed requires a valid site.url (like Atom)', () => {
  const bad = { ...config, site: { ...config.site, url: '' } };
  assert.throws(() => renderJsonFeed(sampleItems, bad, '2026-06-10T12:00:00Z'));
});

test('feed discovery link only appears when site.url is valid http(s)', () => {
  const withUrl = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.ok(withUrl.includes('application/atom+xml'));
  assert.ok(withUrl.includes('application/feed+json')); // JSON Feed autodiscovery too
  const noUrl = { ...config, site: { ...config.site, url: '' } };
  assert.ok(!renderHTML(sampleItems, noUrl, '2026-06-10T12:00:00Z', '').includes('atom+xml'));
});

// ---------- commit-msg checker (shift-left guard) ----------

test('checker accepts internal commits without publish preview', () => {
  const r = checkCommitMessage('chore(deps): bump eslint', config);
  assert.equal(r.ok, true);
  assert.equal(r.willPublish, false);
});

test('checker rejects malformed messages', () => {
  const r = checkCommitMessage('fixed some stuff', config);
  assert.equal(r.ok, false);
});

test('checker previews exactly what will publish', () => {
  const r = checkCommitMessage(':sparkles: feat: add CSV export to reports', config);
  assert.equal(r.ok, true);
  assert.equal(r.willPublish, true);
  assert.match(r.preview, /✨ \[New Feature\] Added CSV export to reports/);
});

test('checker blocks a publishing commit containing a secret', () => {
  const r = checkCommitMessage(
    'fix: rotate key',
    config,
    'New key is ghp_0123456789abcdefghijABCDEFGHIJ12345678'
  );
  assert.equal(r.ok, false);
  assert.equal(r.willPublish, true);
  assert.ok(!r.errors.join(' ').includes('ghp_0123456789')); // redacted
});

test('checker never blocks internal commits for secret-looking text', () => {
  const r = checkCommitMessage('chore: move db to 10.0.0.5', config);
  assert.equal(r.ok, true);
  assert.equal(r.willPublish, false);
});

test('checker allows machine-generated messages', () => {
  assert.equal(checkCommitMessage('Merge branch main into dev', config).ok, true);
  assert.equal(checkCommitMessage('Revert "feat: x"', config).ok, true);
});

// ---------- leak guard ----------

test('guard flags secrets, credentials, emails, and internal hosts', () => {
  const bad = [
    'Rotated token ghp_0123456789abcdefghijABCDEFGHIJ12345678',
    'DB now at 10.0.0.5:5432',
    'Contact ops@agency-internal.com for access',
    'password=hunter2secret',
    'Moved api.corp.local behind the gateway',
    'Swapped sk_live_a1B2c3D4e5F6g7H8i9J0 for the new one',
  ];
  for (const text of bad) {
    assert.ok(auditPublishable([text]).length > 0, `should flag: ${text}`);
  }
});

test('guard passes normal client-facing messages', () => {
  const good = [
    'Launched the new payment gateway integration',
    'Fixed reliability issue causing random logouts',
    'Sped up data lookups',
    'Version 2.0 of the dashboard is live',
  ];
  assert.equal(auditPublishable(good).length, 0);
});

test('guard allowlist permits deliberate exceptions', () => {
  const msgs = ['Email support@agency.com any time'];
  assert.ok(auditPublishable(msgs).length > 0);
  assert.equal(auditPublishable(msgs, ['^support@agency\\.com$']).length, 0);
});

test('guard deny adds org-specific redaction rules (codenames, client names)', () => {
  // Harmless to the built-in detectors, but a team may want it blocked from
  // client-facing copy — that is what guard.deny is for.
  const msgs = ['Shipped Project Phoenix dashboard'];
  assert.equal(auditPublishable(msgs).length, 0); // built-ins don't flag it
  assert.ok(auditPublishable(msgs, [], ['Project\\s+Phoenix']).length > 0);
});

test('guard deny accepts {name, pattern} objects and labels the violation', () => {
  const [v] = auditPublishable(
    ['Migrated ACME-1234 ticket flow'],
    [],
    [{ name: 'ticket-id', pattern: 'ACME-\\d+' }]
  );
  assert.equal(v.pattern, 'custom:ticket-id');
  assert.ok(!v.match.includes('ACME-1234')); // redacted in the report, not echoed
});

test('guard allow can still exempt a deny match', () => {
  const msgs = ['Launched Project Phoenix'];
  assert.equal(auditPublishable(msgs, ['Project Phoenix'], ['Project\\s+Phoenix']).length, 0);
});

test('guard deny ignores malformed entries instead of throwing', () => {
  const msgs = ['nothing sensitive here'];
  // null, object-without-pattern, invalid regex, and a number must all be
  // skipped quietly — the commit-msg hook is fail-open and must not crash.
  assert.doesNotThrow(() => auditPublishable(msgs, [], [null, { name: 'x' }, '(((', 42]));
  assert.equal(auditPublishable(msgs, [], [null, '(((']).length, 0);
});

test('guard reports redacted matches, never the full secret', () => {
  const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ12345678';
  const [v] = auditPublishable([`leaked ${secret}`]);
  assert.ok(!v.match.includes(secret));
  assert.ok(v.match.includes('***'));
});

test('guard redaction survives $-replacement tokens and repeated secrets', () => {
  // "$&" in a replacement string re-expands to the whole match — the redacted
  // context must not fall for it.
  const [v1] = auditPublishable(['Fixed login password=hunter2secret$& for staging']);
  assert.ok(!v1.context.includes('password=hunter2secret$&'), v1.context);
  // A secret appearing twice in the context window must be redacted both times.
  const [v2] = auditPublishable(['key AKIAIOSFODNN7EXAMPLE then AKIAIOSFODNN7EXAMPLE again']);
  assert.ok(!v2.context.includes('AKIAIOSFODNN7EXAMPLE'), v2.context);
});

test('checker folds a wrapped first paragraph like git %s does', () => {
  // The secret is on line 2 of the SUBJECT paragraph — git folds it into %s,
  // so the hook must audit it too.
  const r = checkCommitMessage(
    'feat(client): add export\nusing password=supersecret123 for demo',
    config
  );
  assert.equal(r.ok, false);
  assert.equal(r.willPublish, true);
});

test('Atom feed gives same-day duplicate messages distinct ids', () => {
  const dup = [
    { isoDate: '2026-06-10T08:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed typo' },
    { isoDate: '2026-06-10T17:00:00Z', emoji: '🐛', category: 'Fix', message: 'Fixed typo' },
  ];
  const xml = renderAtom(dup, config, '2026-06-10T17:00:00Z');
  const ids = [...xml.matchAll(/<id>(urn:portal:[^<]+)<\/id>/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('Atom feed normalizes a missing trailing slash in site.url', () => {
  const noSlash = { ...config, site: { ...config.site, url: 'https://example.com/portal' } };
  const xml = renderAtom(sampleItems, noSlash, '2026-06-10T12:00:00Z');
  assert.ok(xml.includes('href="https://example.com/portal/feed.xml"'), xml.slice(0, 400));
});

// ---------- download bundle completeness ----------

test('both published bundles include every module their entry points import', () => {
  // Regression guard: generate.mjs grew imports (media/vocab/manifest/digest/
  // cache, gui) that were missing from the FILES lists of pack-download.mjs
  // (buyer bundle) AND publish-oss.mjs (public source repo) — shipping trees
  // that crash at ESM resolution. Parse each list from source (importing would
  // run the packer) and follow every local import of the listed .mjs files.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const norm = (p) => p.replaceAll(String.fromCharCode(92), String.fromCharCode(47));
  // publish-oss.mjs stages the public repo and is itself absent from it, so
  // only audit the packers present in the tree the suite runs in.
  const packers = ['scripts/pack-download.mjs', 'scripts/publish-oss.mjs'].filter((f) =>
    existsSync(resolve(repoRoot, f))
  );
  assert.ok(packers.length >= 1);
  for (const packer of packers) {
    const src = readFileSync(resolve(repoRoot, packer), 'utf8');
    const block = src.match(/const FILES = \[([\s\S]*?)\];/);
    assert.ok(block, `could not find the FILES list in ${packer}`);
    const files = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(files.includes('scripts/generate.mjs'), packer);
    const missing = [];
    for (const rel of files.filter((f) => f.endsWith('.mjs'))) {
      const code = readFileSync(resolve(repoRoot, rel), 'utf8');
      for (const m of code.matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = norm(relative(repoRoot, resolve(dirname(resolve(repoRoot, rel)), m[1])));
        if (!files.includes(target)) missing.push(`${packer}: ${rel} imports ${target}`);
      }
    }
    assert.deepEqual(missing, [], `${packer} FILES list is missing imported modules`);
  }
});
