#!/usr/bin/env node
// Build downloads/commitport-setup.exe from installer/commitport.iss using Inno
// Setup's compiler (ISCC). Requires commitport.exe to be built first
// (`npm run build:exe`) and Inno Setup 6 installed
// (`winget install JRSoftware.InnoSetup`). Reproducible: `npm run build:installer`.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signFile } from './lib/sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = resolve(ROOT, 'downloads', 'commitport.exe');
if (!existsSync(exe)) {
  console.error('downloads/commitport.exe not found — run `npm run build:exe` first.');
  process.exit(1);
}

const candidates = [
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
].filter(Boolean);
const iscc = candidates.find((p) => existsSync(p));
if (!iscc) {
  console.error('ISCC.exe (Inno Setup 6) not found. Install with: winget install JRSoftware.InnoSetup');
  process.exit(1);
}

console.log(`Compiling installer with ${iscc} ...`);
execFileSync(iscc, [resolve(ROOT, 'installer', 'commitport.iss')], { cwd: ROOT, stdio: 'inherit' });

const out = resolve(ROOT, 'downloads', 'commitport-setup.exe');
// Sign the finished installer (the inner commitport.exe is already signed by
// build-exe). No-op unless a cert is configured.
console.log('Code-signing the installer...');
signFile(out);
console.log(`\nDone -> ${out}  (${(statSync(out).size / 1e6).toFixed(0)} MB)`);
