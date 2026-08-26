// Tamper-evident build manifest. Every published file gets a SHA-256 recorded
// in manifest.json, so the portal you handed a client can later be checked,
// byte-for-byte, against what commitport actually generated (`commitport
// verify`). The build is deterministic — same commits in, same bytes out — so
// a clean rebuild reproduces the same hashes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Manifest entries are basenames written into the SAME directory. Anything with
// a path separator or `..` is rejected on verify so a tampered manifest can't
// point the verifier at files outside the output directory.
const isPlainName = (name) =>
  typeof name === 'string' && name.length > 0 && !/[\\/]/.test(name) && !name.includes('..');

/**
 * Build the manifest object for the given output files (basenames). Missing
 * files are skipped. `generatedAt` is the build's day-stamp (not a wall clock),
 * keeping the manifest reproducible.
 */
export function buildManifest({ outDir, files, generatedAt }) {
  const entries = [];
  for (const name of files) {
    const p = resolve(outDir, name);
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    entries.push({ name, sha256: sha256(buf), bytes: buf.length });
  }
  return { tool: 'commitport', generatedAt, files: entries };
}

/**
 * Re-hash the files listed in <outDir>/manifest.json and compare. Returns
 * { ok, checked, mismatches: [{ name, reason }] }. Read-only and fail-safe.
 */
export function verifyManifest(outDir) {
  const manifestPath = resolve(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, checked: 0, mismatches: [{ name: 'manifest.json', reason: 'not found' }] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, checked: 0, mismatches: [{ name: 'manifest.json', reason: 'invalid JSON' }] };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const mismatches = [];
  for (const f of files) {
    if (!isPlainName(f?.name)) {
      mismatches.push({ name: String(f?.name), reason: 'invalid file name' });
      continue;
    }
    const p = resolve(outDir, f.name);
    if (!existsSync(p)) {
      mismatches.push({ name: f.name, reason: 'missing' });
      continue;
    }
    if (sha256(readFileSync(p)) !== f.sha256) {
      mismatches.push({ name: f.name, reason: 'hash mismatch' });
    }
  }
  return { ok: mismatches.length === 0, checked: files.length, mismatches };
}
