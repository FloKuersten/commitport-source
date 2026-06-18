#!/usr/bin/env node
// Build a single commitport executable — a Node Single Executable Application
// that bundles the generator and EMBEDS its runtime assets, so a buyer needs no
// Node install (only git). Reproducible: `npm run build:exe`.
//
// CROSS-PLATFORM: builds for whatever OS you run it on. On Windows it produces a
// branded commitport.exe (icon + version + optional Authenticode signing); on
// macOS/Linux it produces a `commitport` binary (icon/installer are
// Windows-only). Build the Mac/Linux binaries by running this on those OSes
// (e.g. a CI matrix) — the SEA blob is platform-independent, the host node is not.
//
// Pipeline: esbuild (ESM -> one CJS) -> node --experimental-sea-config (blob)
//   -> copy the host node binary -> [win: rcedit] -> postject -> [win: sign].
// Build-time only: esbuild + postject (+ rcedit on Windows) are devDependencies.

import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signFile } from './lib/sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(ROOT, 'build', 'exe');
const OUT = resolve(ROOT, 'downloads');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const OUTNAME = WIN ? 'commitport.exe' : 'commitport';

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });

console.log('1/6  esbuild: bundling the generator into one CJS file...');
sh(
  'npx esbuild scripts/generate.mjs --bundle --platform=node --format=cjs ' +
    '--target=node20 --outfile=build/exe/bundle.cjs'
);

console.log('2/6  writing SEA config (embeds portal.css + starter config)...');
writeFileSync(
  resolve(BUILD, 'sea-config.json'),
  JSON.stringify(
    {
      main: 'build/exe/bundle.cjs',
      output: 'build/exe/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      assets: {
        'portal.css': 'assets/portal.css',
        'portal.config.json': 'config/portal.config.json',
      },
    },
    null,
    2
  ) + '\n'
);

console.log('3/6  generating the SEA blob...');
sh(`"${process.execPath}" --experimental-sea-config build/exe/sea-config.json`);

console.log('4/6  copying the host node binary...');
const exe = resolve(OUT, OUTNAME);
copyFileSync(process.execPath, exe);

// 5: branding — Windows only (PE icon + version via rcedit), BEFORE postject so
// the resource-table rewrite doesn't disturb the injected blob.
if (WIN) {
  console.log('5/6  branding: icon + version metadata (rcedit)...');
  const { rcedit } = await import('rcedit');
  await rcedit(exe, {
    icon: resolve(ROOT, 'assets/commitport.ico'),
    'version-string': {
      ProductName: 'commitport',
      FileDescription: 'commitport - git history your clients can read',
      CompanyName: 'commitport',
      OriginalFilename: 'commitport.exe',
      LegalCopyright: '(c) commitport',
    },
    'file-version': '1.0.0',
    'product-version': '1.0.0',
  });
} else {
  console.log('5/6  branding: skipped (PE icon/version is Windows-only).');
}

console.log('6/6  injecting the SEA blob (postject)...');
sh(
  `npx postject "${exe}" NODE_SEA_BLOB build/exe/sea-prep.blob --sentinel-fuse ${FUSE}` +
    (MAC ? ' --macho-segment-name NODE_SEA' : '')
);

if (!WIN) chmodSync(exe, 0o755); // make the Unix binary executable
if (MAC) {
  // macOS refuses to run a modified binary without a signature; ad-hoc is enough
  // to run locally (a real Developer ID signature is a separate distribution step).
  console.log('     ad-hoc codesign (required to run on macOS)...');
  sh(`codesign --sign - --force "${exe}"`);
}
if (WIN) {
  // Authenticode signing must be LAST (after postject) so the signature stays valid.
  console.log('     code-signing...');
  signFile(exe);
}

console.log(`\nDone -> ${exe}  (${process.platform}/${process.arch}, ${(statSync(exe).size / 1e6).toFixed(0)} MB)`);
