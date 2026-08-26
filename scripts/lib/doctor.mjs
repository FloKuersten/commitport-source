// `commitport doctor` — explain a setup before it disappoints someone.
//
// The overwhelmingly common first-run outcome is "it published nothing", and
// the build's one-line summary doesn't say WHY: no marked commits? every
// candidate caught by the internal-scope denylist? a range that excludes
// everything? This walks the same pipeline the build uses and reports what it
// found, so the answer is on screen instead of in a support email.
//
// Pure and dependency-free: it takes the already-parsed commits and config and
// returns structured findings, so it is testable without touching git or disk.

/** Severity ordering used for the exit code and the summary line. */
export const LEVELS = { pass: 'pass', warn: 'warn', fail: 'fail' };

const ok = (title, detail) => ({ level: 'pass', title, detail });
const warn = (title, detail, fix) => ({ level: 'warn', title, detail, fix });
const fail = (title, detail, fix) => ({ level: 'fail', title, detail, fix });

/**
 * Diagnose a configuration against the commits it would actually see.
 *
 * @param {object}   a
 * @param {object}   a.config       the loaded portal config
 * @param {object[]} a.parsed       every parsed commit in range (pre-classify)
 * @param {object[]} a.classified   the commits that would publish
 * @param {number}   a.scanned      how many commits git returned
 * @param {boolean}  a.hasCss       whether the precompiled stylesheet resolved
 * @param {string[]} a.guardHits    messages the leak guard would reject
 * @returns {{checks: object[], ok: boolean}}
 */
export function diagnose({
  config = {},
  parsed = [],
  classified = [],
  scanned = 0,
  hasCss = true,
  guardHits = [],
} = {}) {
  const checks = [];

  // 1. Is there any history to read at all?
  if (scanned === 0) {
    checks.push(
      fail(
        'No commits in range',
        'git returned nothing for this repository and range.',
        'Check you are pointing at the right repo (--repo), and that range.sinceTag / after / before in your config are not excluding everything.'
      )
    );
  } else {
    checks.push(ok('History readable', `${scanned} commit(s) in range.`));
  }

  // 2. The headline question: will anything reach the client?
  if (scanned > 0 && classified.length === 0) {
    const internal = config.internalScopes || [];
    const blocked = parsed.filter((c) => c.scope && internal.includes(c.scope));
    const marked = parsed.filter(
      (c) => c.clientMessage || c.gitmojiShortcode || c.gitmojiUnicode || c.scope
    );
    let why =
      'None of the commits carry a client marker — no client gitmoji, no client scope, and no Client: trailer.';
    let fix =
      'Mark a commit for the client: a gitmoji (:sparkles:), a (client) scope, or a "Client: ..." trailer. `commitport stats` shows the tally.';
    if (blocked.length) {
      why = `${blocked.length} commit(s) matched an internal scope (${internal.join(', ')}), which always wins over any marker.`;
      fix = 'Re-scope those commits, or remove that scope from internalScopes in your config.';
    } else if (marked.length && config.publishMode === 'explicit') {
      why = `publishMode is "explicit", so a gitmoji alone does not publish — only ${(config.clientScopes || []).join(', ') || 'client scopes'} and Client: trailers do.`;
      fix = 'Use a client scope or a Client: trailer, or set publishMode back to "gitmoji".';
    }
    checks.push(fail('Nothing would publish', why, fix));
  } else if (classified.length) {
    checks.push(
      ok('Client-facing commits found', `${classified.length} of ${scanned} would publish.`)
    );
  }

  // 3. The guard is the difference between a portal and an incident.
  if (guardHits.length) {
    checks.push(
      fail(
        'Leak guard would block the build',
        `${guardHits.length} client-facing message(s) look like they contain a secret, credential, email, or internal hostname.`,
        'Reword the commit (git commit --amend), publish a safe wording via a Client: trailer, or add a deliberate exception under guard.allow.'
      )
    );
  } else if (classified.length) {
    checks.push(ok('Leak guard clean', 'No client-facing message trips a detector.'));
  }

  // 4. Feeds and absolute links need a public URL.
  if (!config.site?.url) {
    checks.push(
      warn(
        'No public URL configured',
        'site.url is empty, so no Atom or JSON feed is written and entries have no absolute links.',
        'Set site.url to where the portal will be hosted, e.g. https://acme.com/progress/.'
      )
    );
  } else {
    checks.push(ok('Public URL set', config.site.url));
  }

  // 5. A missing stylesheet produces an unstyled portal.
  if (!hasCss) {
    checks.push(
      fail(
        'Stylesheet missing',
        'assets/portal.css could not be read, so the portal would have no styling.',
        'Run `npm run build:css` (needs network once), or reinstall commitport.'
      )
    );
  }

  // 6. Per-client profiles are easy to mis-scope — silently.
  for (const p of config.profiles || []) {
    const n = parsed.filter((c) => c.scope && (p.scopes || []).includes(c.scope)).length;
    if (n === 0) {
      checks.push(
        warn(
          `Profile "${p.name || p.out}" matches no commits`,
          `No commit in range uses the scope(s): ${(p.scopes || []).join(', ') || '(none)'}.`,
          `Commit with that scope, e.g. feat(${(p.scopes || ['client'])[0]}): …, or correct the profile's scopes.`
        )
      );
    } else {
      checks.push(ok(`Profile "${p.name || p.out}"`, `${n} commit(s) in scope.`));
    }
  }

  // 7. Placeholder title — the client sees this first.
  const title = config.site?.title || '';
  if (/your project|project g|example/i.test(title)) {
    checks.push(
      warn(
        'Title is still a placeholder',
        `site.title is "${title}", which your client will see at the top of the page.`,
        'Set site.title to something client-facing, e.g. "Acme — Progress".'
      )
    );
  }

  return { checks, ok: !checks.some((c) => c.level === 'fail') };
}

/** Render findings for a terminal. Exported so the CLI stays a thin wrapper. */
export function formatReport({ checks, ok: allOk }) {
  const mark = { pass: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  const lines = checks.map((c) => {
    const head = `${mark[c.level]}  ${c.title}${c.detail ? ` — ${c.detail}` : ''}`;
    return c.fix ? `${head}\n        fix: ${c.fix}` : head;
  });
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(
    '',
    allOk
      ? `commitport doctor: ready to build${warns ? ` (${warns} warning${warns === 1 ? '' : 's'})` : ''}.`
      : `commitport doctor: ${fails} problem${fails === 1 ? '' : 's'} to fix before this publishes.`
  );
  return lines.join('\n');
}
