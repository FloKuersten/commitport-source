// Phase 1 — Log extraction & parsing.
// Pulls raw history from git via a child process and parses each commit into a
// structured object. Zero dependencies, zero network, zero database.
//
// Integrity notes (these are load-bearing, do not "simplify" them away):
//  - Records are NUL-separated (`-z`). NUL is the ONLY byte git forbids in a
//    commit message, so an attacker-authored commit cannot smuggle a forged
//    record (fake hash / backdated timestamp / fabricated subject) into the
//    stream the way it could with in-band separators like \x1e.
//  - Fields are \x1f-separated INSIDE a record. A crafted message CAN contain
//    \x1f, which would shift fields — so any record without exactly the
//    expected field count is dropped, and hash/date shapes are validated.
//  - The Client: trailer is extracted by git's own trailer parser
//    (%(trailers:key=Client)), not by regex-grepping the body, so only a
//    genuine trailer block (last paragraph, `Client: ...`) counts as intent.
//  - All published text is stripped of control and bidi-override characters,
//    which are invisible in review UIs and can reorder rendered text.

import { execFileSync } from 'node:child_process';

// Field separator inside one record (records themselves are NUL-separated).
const FS = '\x1f';

const FORMAT = [
  '%H', // commit hash
  '%aI', // author date, strict ISO 8601
  '%s', // subject
  '%(trailers:key=Client,valueonly,unfold=true)', // genuine Client: trailer(s)
  '%(trailers:key=Image,valueonly,unfold=true)', // optional Image: trailer (screenshot)
  '%b', // body
].join(FS);

const HASH_RE = /^[0-9a-f]{40,64}$/;

// C0 controls (minus \n and \t) + DEL + Unicode bidi/direction overrides.
const CONTROL_OR_BIDI_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩‎‏]/g;
const sanitizeText = (s) => (s || '').replace(CONTROL_OR_BIDI_RE, '');

/**
 * Run `git log` and return validated raw commit records.
 * --no-merges drops the structural noise of branch merges (per the spec).
 */
export function readGitLog({ sinceTag, after, before, includePaths = [], cwd } = {}) {
  const args = ['log', '--no-merges', '-z', `--pretty=format:${FORMAT}`];

  if (sinceTag) args.push(`${sinceTag}..HEAD`);
  if (after) args.push(`--after=${after}`);
  if (before) args.push(`--before=${before}`);
  if (includePaths.length) args.push('--', ...includePaths);

  let out;
  try {
    out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `git log failed — is this a git repository with history?\n${err.stderr || err.message}`
    );
  }

  return parseLogOutput(out);
}

/**
 * Parse and validate NUL-separated log output. Exported for testing.
 * Malformed records (wrong field count, bad hash, bad date) are DROPPED with a
 * warning rather than published — fail closed.
 */
export function parseLogOutput(out) {
  const records = [];
  for (const record of out.split('\0')) {
    if (!record.trim()) continue;

    const parts = record.split(FS);
    if (parts.length !== 6) {
      console.warn('portal: dropping malformed log record (unexpected field count)');
      continue;
    }
    const [hash, isoDate, subject, trailerRaw, imageRaw, body] = parts;
    if (!HASH_RE.test(hash.trim())) {
      console.warn('portal: dropping malformed log record (bad hash)');
      continue;
    }
    if (Number.isNaN(Date.parse(isoDate.trim()))) {
      console.warn('portal: dropping malformed log record (bad date)');
      continue;
    }

    // Multiple Client:/Image: trailers -> first one wins.
    const clientTrailer = sanitizeText(trailerRaw).split('\n')[0].trim() || null;
    const imageTrailer = sanitizeText(imageRaw).split('\n')[0].trim() || null;

    records.push({
      hash: hash.trim(),
      isoDate: isoDate.trim(),
      subject: sanitizeText(subject).trim(),
      clientTrailer,
      imageTrailer,
      body: sanitizeText(body),
    });
  }
  return records;
}

// Leading gitmoji as a :shortcode: e.g. ":sparkles:"
const SHORTCODE_RE = /^(:[a-z0-9_+\-]+:)\s*/;
// Leading unicode emoji (one or more pictographic clusters), with optional VS-16.
const UNICODE_EMOJI_RE = /^(\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}️?)*)\s*/u;
// Conventional Commits header: type(scope)!: description
const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/s;

const stripVariationSelectors = (s) => (s ? s.replace(/[︎️]/g, '') : s);

/**
 * Parse one raw commit into structured fields.
 * Recognises a leading gitmoji (shortcode OR unicode) and a Conventional header.
 */
export function parseCommit(raw) {
  let text = raw.subject ?? '';
  let gitmojiShortcode = null;
  let gitmojiUnicode = null;

  const sc = text.match(SHORTCODE_RE);
  if (sc) {
    gitmojiShortcode = sc[1];
    text = text.slice(sc[0].length);
  } else {
    const uni = text.match(UNICODE_EMOJI_RE);
    if (uni) {
      gitmojiUnicode = stripVariationSelectors(uni[1]);
      text = text.slice(uni[0].length);
    }
  }

  let type = null;
  let scope = null;
  let breaking = false;
  let description = text.trim();

  const conv = text.match(CONVENTIONAL_RE);
  if (conv) {
    type = conv[1].toLowerCase();
    scope = conv[2] ? conv[2].toLowerCase() : null;
    breaking = Boolean(conv[3]) || /(^|\n)BREAKING[ -]CHANGE:/.test(raw.body || '');
    description = conv[4].trim();
  }

  return {
    hash: raw.hash,
    isoDate: raw.isoDate,
    gitmojiShortcode,
    gitmojiUnicode,
    type,
    scope,
    breaking,
    description,
    clientMessage: raw.clientTrailer ?? null,
    imagePath: raw.imageTrailer ?? null,
    body: raw.body || '',
  };
}

/**
 * Decide whether a parsed commit is meant for the client portal, and attach the
 * matching presentation metadata (emoji / category / verb).
 *
 * Inclusion rules, in priority order:
 *   1. A commit whose scope is on the internal denylist NEVER publishes — the
 *      explicit privacy control beats everything, including a Client: trailer.
 *   2. A genuine `Client:` git trailer publishes (verbatim text, engineer-written).
 *   3. publishMode "explicit": only client-designated scopes publish; a gitmoji
 *      is presentation metadata, not a publish trigger (fail-closed for teams
 *      that use gitmoji habitually).
 *      publishMode "gitmoji" (default): a client-designated gitmoji OR a
 *      client-designated scope publishes. Everything else drops silently.
 */
export function classify(commit, config) {
  const {
    gitmojiMap,
    typeMap,
    clientScopes = [],
    internalScopes = [],
    publishMode = 'gitmoji',
    // Changelog mode: also publish any commit whose Conventional Commit type is
    // in this list (e.g. ["feat","fix","perf"]) — no gitmoji/scope marker needed.
    // The internal-scope denylist still wins.
    includeTypes = [],
  } = config;

  // Build a lookup that resolves both shortcodes and unicode emoji to meta.
  const byShortcode = gitmojiMap;
  const byUnicode = {};
  for (const [code, meta] of Object.entries(gitmojiMap)) {
    if (meta.emoji) byUnicode[stripVariationSelectors(meta.emoji)] = { ...meta, shortcode: code };
  }

  let meta = null;
  if (commit.gitmojiShortcode && byShortcode[commit.gitmojiShortcode]) {
    meta = { ...byShortcode[commit.gitmojiShortcode], shortcode: commit.gitmojiShortcode };
  } else if (commit.gitmojiUnicode && byUnicode[commit.gitmojiUnicode]) {
    meta = byUnicode[commit.gitmojiUnicode];
  }

  const scopeIsClient = commit.scope && clientScopes.includes(commit.scope);
  const scopeIsInternal = commit.scope && internalScopes.includes(commit.scope);

  let included;
  if (scopeIsInternal) included = false; // rule 1: privacy always wins
  else if (commit.clientMessage) included = true; // rule 2
  else if (publishMode === 'explicit') included = Boolean(scopeIsClient); // rule 3a
  else included = Boolean(meta) || scopeIsClient; // rule 3b
  // Changelog mode (rule 4): include by conventional type — but the internal
  // scope denylist always wins, so secrets/noise never leak even here.
  if (!included && !scopeIsInternal && commit.type && includeTypes.includes(commit.type))
    included = true;

  if (!included) return null;

  // No recognised gitmoji (scope- or trailer-only match): derive presentation
  // from the conventional type, falling back to a neutral announcement.
  if (!meta) {
    const t = (commit.type && typeMap[commit.type]) || {};
    meta = {
      emoji: t.emoji || '📣',
      category: t.category || 'Update',
      verb: t.verb || 'Updated',
    };
  }

  return {
    ...commit,
    emoji: meta.emoji,
    category: meta.category,
    verb: meta.verb,
  };
}
