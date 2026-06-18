#!/usr/bin/env node
// Build commitport.exe — a single Windows executable (Node Single Executable
// Application) that bundles the generator and EMBEDS its runtime assets, so a
// buyer needs no Node install (only git). Reproducible: `npm run build:exe`.
//
// Pipeline: esbuild (ESM -> one CJS) -> node --experimental-sea-config (blob)
//   -> copy node.exe -> postject (inject blob). Output: downloads/commitport.exe
//
// Build-time only: esbuild + postject are devDependencies. The shipped binary
// stays zero-runtime-dependency (it IS the Node runtime + our bundled script).

import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';
import { signFile } from './lib/sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(ROOT, 'build', 'exe');
const OUT = resolve(ROOT, 'downloads');
// Node's documented SEA fuse sentinel — postject injects the blob between it.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

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

console.log('4/6  copying the node binary...');
const exe = resolve(OUT, 'commitport.exe');
copyFileSync(process.execPath, exe);

// Brand the binary BEFORE postject: rcedit rewrites the PE resource table, and
// doing that to a postject-modified binary can corrupt/stall it. postject then
// appends the SEA blob as its own resource and preserves the icon/version.
console.log('5/6  branding: icon + version metadata (rcedit)...');
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

console.log('6/6  injecting the SEA blob (postject)...');
sh(`npx postject "${exe}" NODE_SEA_BLOB build/exe/sea-prep.blob --sentinel-fuse ${FUSE}`);

// Authenticode signing must be LAST (after postject) so the signature stays valid.
console.log('     code-signing...');
signFile(exe);

console.log(`\nDone -> ${exe}  (${(statSync(exe).size / 1e6).toFixed(0)} MB)`);
