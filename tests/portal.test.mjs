// Test suite — node:test, zero dependencies. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseLogOutput, parseCommit, classify } from '../scripts/lib/parse-commits.mjs';
import { translate } from '../scripts/lib/translate.mjs';
import { renderHTML, renderJSON, renderAtom } from '../scripts/lib/render.mjs';
import { auditPublishable } from '../scripts/lib/guard.mjs';
import { checkCommitMessage } from '../scripts/check-commit-msg.mjs';

const config = JSON.parse(
  readFileSync(new URL('../config/portal.config.json', import.meta.url), 'utf8')
);

const raw = (subject, { trailer = null, body = '' } = {}) => ({
  hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  isoDate: '2026-06-10T12:00:00Z',
  subject,
  clientTrailer: trailer,
  body,
});

const pipelineOne = (subject, opts = {}, cfg = config) => {
  const c = classify(parseCommit(raw(subject, opts)), cfg);
  return c ? { ...c, message: translate(c, cfg).message } : null;
};

// ---------- log-output parsing & record integrity ----------

const FS = '\x1f';
const record = (hash, date, subject, trailer, body) =>
  [hash, date, subject, trailer, body].join(FS);
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

test('HTML honors dark mode via compiled CSS, not JS', () => {
  const html = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.ok(html.includes('name="color-scheme" content="light dark"'));
  assert.ok(html.includes('prefers-color-scheme: dark'));
  assert.ok(!/<script/i.test(html));
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

test('feed discovery link only appears when site.url is valid http(s)', () => {
  const withUrl = renderHTML(sampleItems, config, '2026-06-10T12:00:00Z', '');
  assert.ok(withUrl.includes('application/atom+xml'));
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
