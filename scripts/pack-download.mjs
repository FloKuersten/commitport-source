#!/usr/bin/env node
// Builds the customer-facing commitport bundle that buyers download after
// purchase: the static-site generator + config + docs, with a trimmed
// package.json and a getting-started guide. Server-only code (server/, the
// license infra, deploy/, .env) is deliberately NOT included.
//
// Output: downloads/commitport.tgz  (served by GET /download to valid licenses)
// Requires `tar` on PATH (present on the VPS and in Git Bash).

import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'downloads');
const STAGE = resolve(OUT_DIR, '_stage');
const PKG = resolve(STAGE, 'commitport');

// The generator the customer self-hosts. Every import these files make must be
// in this list (verified: generate/check-commit-msg/check-css pull only from
// scripts/lib/* below; serve/demo/install-hooks are self-contained).
const FILES = [
  'scripts/generate.mjs',
  'scripts/serve.mjs',
  'scripts/demo.mjs',
  'scripts/install-hooks.mjs',
  'scripts/check-css.mjs',
  'scripts/check-commit-msg.mjs',
  'scripts/gui.mjs',
  'scripts/lib/parse-commits.mjs',
  'scripts/lib/translate.mjs',
  'scripts/lib/render.mjs',
  'scripts/lib/guard.mjs',
  'scripts/lib/media.mjs',
  'scripts/lib/vocab.mjs',
  'scripts/lib/manifest.mjs',
  'scripts/lib/doctor.mjs',
  'scripts/lib/digest.mjs',
  'scripts/lib/cache.mjs',
  'config/portal.config.json',
  'assets/portal.css',
  'assets/tailwind.in.css',
  'hooks/commit-msg',
  'README.md',
  '.github/workflows/deploy.yml',
];

const PACKAGE_JSON = {
  name: 'commitport',
  version: '1.0.0',
  private: true,
  type: 'module',
  description: 'commitport — turn your git commits into a client-ready progress portal.',
  bin: { commitport: 'scripts/generate.mjs' },
  scripts: {
    build: 'node scripts/generate.mjs',
    'build:ai': 'node scripts/generate.mjs --ai',
    preview: 'node scripts/serve.mjs',
    demo: 'node scripts/demo.mjs',
    hooks: 'node scripts/install-hooks.mjs',
  },
  engines: { node: '>=18' },
  license: 'LicenseRef-commitport-EULA',
};

const GETTING_STARTED = `# commitport — getting started

Thanks for your license! commitport is a zero-dependency, database-free static
generator: it reads your git history and produces a client-facing progress portal.

## 1. Requirements
- Node.js 18+ (no dependencies to install).

## 2. See it work
\`\`\`bash
npm run demo       # builds a sample repo and generates a portal into ./public
npm run preview    # serve it at http://localhost:8080
\`\`\`

## 3. Run it against your repo
\`\`\`bash
npm run build      # reads THIS repo's git log -> ./public/index.html + data.json
npm run preview
\`\`\`

## 4. Mark commits for clients
Only commits you mark are published. Use a client gitmoji (✨ 🚑 🐛 🔒 ⚡ 📝),
a \`(client)\`/\`(public)\` scope, or a \`Client:\` trailer for exact wording:
\`\`\`bash
git commit -m "fix: handle null in webhook" -m "Client: Notifications are reliable now."
\`\`\`
Optional: \`npm run hooks\` installs a commit-msg check that previews what will
publish and blocks secrets before they leave your machine.

## 5. Publish
See \`.github/workflows/deploy.yml\` for a CI template that builds and pushes the
static \`./public\` to a separate public repo — your source stays private.

Full docs: README.md. Questions: support@commitport.com
`;

const LICENSE = `commitport — End User License Agreement (summary)

This is a commercial, one-time license for self-hosting commitport.
- You may use it on unlimited projects/portals within your own organization.
- You may not resell, sublicense, or redistribute the source.
- Provided "as is", without warranty.

Replace this file with your finalized EULA before selling.
`;

console.log('Packing commitport download bundle...');
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(PKG, { recursive: true });

for (const rel of FILES) {
  const src = resolve(ROOT, rel);
  if (!existsSync(src)) {
    console.error(`!! missing source file: ${rel}`);
    process.exit(1);
  }
  const dest = resolve(PKG, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

writeFileSync(resolve(PKG, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2) + '\n');
writeFileSync(resolve(PKG, 'GETTING-STARTED.md'), GETTING_STARTED);
writeFileSync(resolve(PKG, 'LICENSE.txt'), LICENSE);

// Run tar from inside the stage dir with relative paths so a Windows drive
// letter (e.g. "D:\\") is never parsed by GNU tar as a remote host spec.
const out = resolve(OUT_DIR, 'commitport.tgz');
execFileSync('tar', ['-czf', '../commitport.tgz', 'commitport'], { cwd: STAGE, stdio: 'pipe' });
rmSync(STAGE, { recursive: true, force: true });

console.log(`Wrote ${out}`);
