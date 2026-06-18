#!/usr/bin/env node
// Copies the repo's git hooks into .git/hooks. No-ops gracefully outside a repo
// so it's safe to wire into an npm "prepare" script.

import { copyFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(ROOT, 'hooks');
const dest = join(ROOT, '.git', 'hooks');

if (!existsSync(dest)) {
  console.log('install-hooks: no .git/hooks directory — skipping (not a git repo yet).');
  process.exit(0);
}

for (const name of readdirSync(src)) {
  const target = join(dest, name);
  copyFileSync(join(src, name), target);
  try {
    chmodSync(target, 0o755); // ignored on Windows, needed on macOS/Linux
  } catch {}
  console.log(`install-hooks: installed ${name}`);
}
