// Optional Windows Authenticode signing. This is a NO-OP (logs a hint and returns
// false) unless a certificate is configured — so unsigned builds always succeed.
// Signing an unsigned commitport.exe / commitport-setup.exe is what clears the
// Windows SmartScreen "unknown publisher" warning once you have a cert.
//
// Enable by setting EITHER:
//   COMMITPORT_SIGN_PFX + COMMITPORT_SIGN_PASSWORD   — a .pfx/.p12 file + its password
//   COMMITPORT_SIGN_THUMBPRINT                       — SHA-1 thumbprint of a cert in the Windows store
// Optional:
//   COMMITPORT_SIGN_TIMESTAMP  — RFC-3161 timestamp URL (default DigiCert)
//   COMMITPORT_SIGNTOOL        — explicit path to signtool.exe
//
// IMPORTANT: call signFile() as the LAST step on a binary (after postject / Inno),
// because Authenticode signing appends to the file and any later edit invalidates
// the signature.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function signingConfigured() {
  return Boolean(
    (process.env.COMMITPORT_SIGN_PFX && process.env.COMMITPORT_SIGN_PASSWORD) ||
      process.env.COMMITPORT_SIGN_THUMBPRINT
  );
}

function findSigntool() {
  if (process.env.COMMITPORT_SIGNTOOL && existsSync(process.env.COMMITPORT_SIGNTOOL)) {
    return process.env.COMMITPORT_SIGNTOOL;
  }
  const binRoots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .map((p) => join(p, 'Windows Kits', '10', 'bin'));
  for (const root of binRoots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((d) => /^10\./.test(d))
      .sort()
      .reverse(); // newest SDK first
    for (const v of versions) {
      const cand = join(root, v, 'x64', 'signtool.exe');
      if (existsSync(cand)) return cand;
    }
  }
  return 'signtool'; // fall back to PATH
}

/** Authenticode-sign `file` (SHA-256 + RFC-3161 timestamp). Returns true if signed. */
export function signFile(file) {
  if (!signingConfigured()) {
    console.log(
      `   (unsigned — set COMMITPORT_SIGN_PFX + COMMITPORT_SIGN_PASSWORD, or COMMITPORT_SIGN_THUMBPRINT, to sign)`
    );
    return false;
  }
  const ts = process.env.COMMITPORT_SIGN_TIMESTAMP || 'http://timestamp.digicert.com';
  const args = ['sign', '/fd', 'SHA256', '/tr', ts, '/td', 'SHA256'];
  if (process.env.COMMITPORT_SIGN_THUMBPRINT) {
    args.push('/sha1', process.env.COMMITPORT_SIGN_THUMBPRINT);
  } else {
    args.push('/f', process.env.COMMITPORT_SIGN_PFX, '/p', process.env.COMMITPORT_SIGN_PASSWORD);
  }
  args.push(file);
  try {
    execFileSync(findSigntool(), args, { stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        'signtool.exe not found. Install the Windows SDK "Signing Tools for Desktop Apps", ' +
          'or set COMMITPORT_SIGNTOOL to its full path.'
      );
    }
    throw e;
  }
  console.log(`   signed ${file}`);
  return true;
}
