#!/usr/bin/env node
// Builds a throwaway git repository with a realistic mix of commits, then runs
// the generator against it so you can see the portal without your own repo.
//   node scripts/demo.mjs   ->   writes to ./public, then `npm run preview`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// (message, daysAgo) — a believable agency week. Some are client-facing
// (gitmoji or client/public scope), most are internal noise that must be dropped.
const COMMITS = [
  [':wrench: chore(deps): bump eslint to 9.4.0', 9],
  [':recycle: refactor(auth): extract token validation module', 8],
  [':sparkles: feat: migrate auth module to new JWT standard', 7],
  [':lock: perf(security): encrypt session tokens at rest', 7],
  [':construction: wip: experimenting with new caching layer', 6],
  [':ambulance: fix: fix race condition causing random logouts', 5],
  ['feat(client): add CSV export to the reporting dashboard', 5],
  [':bug: fix(internal): correct typo in log message', 4],
  [':zap: perf(api): optimize database query indexing', 3],
  ['chore: reformat config files', 3],
  [':memo: docs(public): publish updated user guide', 2],
  [':lipstick: feat(client): refresh dashboard with responsive layout', 1],
  ['fix: handle null pointer in webhook handler\n\nClient: Notifications now arrive reliably, even during high traffic.', 0],
];

const tmp = mkdtempSync(join(tmpdir(), 'projectg-demo-'));
const git = (args, env = {}) =>
  execFileSync('git', args, { cwd: tmp, encoding: 'utf8', env: { ...process.env, ...env } });

try {
  git(['init', '-q']);
  git(['config', 'user.email', 'demo@example.com']);
  git(['config', 'user.name', 'Demo Engineer']);
  git(['commit', '--allow-empty', '-q', '-m', 'chore: initialize repository']);

  for (const [msg, daysAgo] of COMMITS) {
    // Fixed base date keeps the demo deterministic across runs.
    const base = new Date('2026-06-10T15:00:00Z').getTime();
    const when = new Date(base - daysAgo * 86400000).toISOString();
    git(['commit', '--allow-empty', '-q', '-m', msg], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });
  }

  console.log(`Demo repo: ${tmp}\n`);
  const out = execFileSync(
    'node',
    // Use the repo-root demo config (branded "Live Client Portal Demo") when
    // present; config/portal.config.json stays the neutral starter buyers get.
    [
      resolve(ROOT, 'scripts/generate.mjs'),
      '--repo', tmp,
      '--out', 'public',
      ...(existsSync(resolve(ROOT, 'portal.config.json'))
        ? ['--config', 'portal.config.json']
        : []),
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  process.stdout.write(out);
  console.log('\nRun `npm run preview` and open http://localhost:8080');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
