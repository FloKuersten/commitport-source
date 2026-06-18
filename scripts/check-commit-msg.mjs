#!/usr/bin/env node
// commit-msg checker — invoked by hooks/commit-msg with the message file path.
//
// Shift-left version of the CI pipeline: validates the Conventional Commits
// format, then runs the message through the ACTUAL classify/translate/guard
// pipeline. The engineer learns at commit time:
//   - whether the commit will appear on the client portal (and exactly how),
//   - that a publishing commit contains a secret — BEFORE it reaches CI,
//     instead of an hour later when the build fails.
// Internal (non-publishing) commits are never blocked by the leak guard:
// mentioning an IP in a chore commit is fine, it stays private.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseCommit, classify } from './lib/parse-commits.mjs';
import { translate } from './lib/translate.mjs';
import { auditPublishable, formatViolations } from './lib/guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MACHINE_RE = /^(Merge |Revert |fixup!|squash!|Initial commit$)/;
const SHORTCODE_RE = /^:[a-z0-9_+\-]+:\s*/;
const FORMAT_RE =
  /^[^\p{L}\p{N}]*\s*(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|wip)(\([a-z0-9 ._/-]+\))?!?:\s.+/u;

const FORMAT_HELP = `Use Conventional Commits, optionally prefixed with a Gitmoji:

    <type>(<scope>): <description>
    :emoji: <type>(<scope>): <description>

  Types:  feat fix docs style refactor perf test build ci chore revert
  Examples:
    feat(client): add CSV export to the reporting dashboard
    :ambulance: fix: resolve random logouts on slow connections
    chore(deps): bump eslint            # internal — kept out of the portal

  To broadcast a hand-written client update, add a body trailer:
    Client: Reports can now be downloaded as a spreadsheet.`;

/**
 * Extract a genuine Client: trailer using git's own trailer parser, matching
 * exactly what the build pipeline will see. Returns null when absent or when
 * git is unavailable (e.g. unit tests pass the trailer in directly).
 */
export function extractClientTrailer(messageText) {
  try {
    const out = execFileSync('git', ['interpret-trailers', '--parse'], {
      input: messageText,
      encoding: 'utf8',
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^client\s*:\s*(.+)$/i);
      if (m) return m[1].trim();
    }
  } catch {
    /* git unavailable — treat as no trailer */
  }
  return null;
}

/**
 * Pure check, exported for tests.
 * Returns { ok, errors: string[], willPublish, preview: string|null }.
 */
export function checkCommitMessage(messageText, config, clientTrailer = null) {
  // Git strips comment lines on finalize; ignore them here too.
  const lines = messageText.split('\n').filter((l) => !l.startsWith('#'));
  // Mirror git's %s semantics, which the real pipeline consumes: the subject is
  // the ENTIRE first paragraph with newlines folded to spaces — not just line 1.
  // Otherwise a wrapped subject line could carry text past the hook's audit.
  const paragraphs = lines.join('\n').replace(/^\s*\n/, '').split(/\n\s*\n/);
  const subject = (paragraphs[0] || '').replace(/\s*\n\s*/g, ' ').trim();
  const body = paragraphs.slice(1).join('\n\n').trim();

  if (!subject) return { ok: false, errors: ['Empty commit message.'], willPublish: false, preview: null };
  if (MACHINE_RE.test(subject)) return { ok: true, errors: [], willPublish: false, preview: null };

  const stripped = subject.replace(SHORTCODE_RE, '');
  if (!FORMAT_RE.test(stripped)) {
    return { ok: false, errors: [FORMAT_HELP], willPublish: false, preview: null };
  }

  // Dry-run the real pipeline with placeholder git metadata.
  const raw = {
    hash: '0'.repeat(40),
    isoDate: '2000-01-01T00:00:00+00:00',
    subject,
    clientTrailer,
    body,
  };
  const safeConfig = { gitmojiMap: {}, typeMap: {}, ...config };
  const item = classify(parseCommit(raw), safeConfig);
  if (!item) return { ok: true, errors: [], willPublish: false, preview: null };

  const { message } = translate(item, safeConfig);
  const violations = auditPublishable([message], safeConfig.guard?.allow ?? []);
  if (violations.length) {
    return {
      ok: false,
      errors: [
        'This commit WOULD BE PUBLISHED to the client portal, and it looks like it contains sensitive data.\n' +
          formatViolations(violations),
      ],
      willPublish: true,
      preview: null,
    };
  }

  return { ok: true, errors: [], willPublish: true, preview: `${item.emoji} [${item.category}] ${message}` };
}

// ---------------------------------------------------------------------------
// CLI: node scripts/check-commit-msg.mjs <commit-msg-file>
// pathToFileURL + realpathSync, NOT a hand-built "file://" string: naive
// concatenation diverges from import.meta.url on symlinked checkouts and on
// paths containing '#' or '%', which would make the hook silently skip ALL
// validation (fail-open). realpath matches Node's resolved module identity.
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    isMain = pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: check-commit-msg.mjs <commit-msg-file>');
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');

  let config = {};
  try {
    config = JSON.parse(readFileSync(resolve(ROOT, 'config/portal.config.json'), 'utf8'));
  } catch {
    console.warn('portal: config/portal.config.json unreadable — format check only.');
  }

  // Don't let one teammate's config typo brick everyone's commits with a raw
  // stack trace: drop invalid allow patterns with a warning (the guard only
  // gets stricter), and turn any remaining failure into an actionable message.
  if (config.guard?.allow !== undefined && !Array.isArray(config.guard.allow)) {
    console.warn('portal: guard.allow must be an array — ignoring it.');
    config.guard.allow = [];
  }
  if (Array.isArray(config.guard?.allow)) {
    config.guard.allow = config.guard.allow.filter((p) => {
      try {
        new RegExp(p, 'i');
        return true;
      } catch {
        console.warn(
          `portal: ignoring invalid guard.allow pattern ${JSON.stringify(p)} — fix config/portal.config.json.`
        );
        return false;
      }
    });
  }

  let result;
  try {
    result = checkCommitMessage(text, config, extractClientTrailer(text));
  } catch (err) {
    console.error(
      `✗ Commit rejected: portal hook hit a config/internal error — fix config/portal.config.json.\n  ${err.message}`
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error('✗ Commit rejected.\n');
    for (const e of result.errors) console.error(e);
    process.exit(1);
  }
  if (result.willPublish) {
    console.error(`ℹ This commit will appear on the client portal as:\n    ${result.preview}`);
  }
  process.exit(0);
}
