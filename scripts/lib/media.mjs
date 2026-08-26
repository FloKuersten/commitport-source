// Optional screenshots. An `Image:` git trailer attaches one local image to a
// portal entry; we inline it as a base64 data URI so the page stays a single,
// self-contained file that makes zero network requests (no external host can
// see the client open the portal).
//
// Security notes (load-bearing — the path comes from a commit, so it is
// attacker-authorable):
//   - absolute paths are rejected;
//   - the path must resolve — including through any symlink — INSIDE the repo,
//     so `Image: ../../../etc/passwd` can never be embedded into a public page;
//   - only a raster image allowlist is accepted (no SVG: it can carry script);
//   - the file size is capped.
// A bad reference is fail-safe: it is warned about and the image is dropped,
// never breaking the build. Image BYTES are embedded as-is — EXIF/metadata is
// NOT stripped (that would need an image-parsing dependency), so the media a
// user attaches is their responsibility.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, extname, isAbsolute } from 'node:path';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MiB on disk

// True when `child` is strictly inside `parent` (no `..` escape, not absolute).
function within(parent, child) {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve an `Image:` trailer to an inline data URI, or null (with a warning)
 * when it is missing, too big, the wrong type, or escapes the repository.
 */
export function loadImageDataUri({ imagePath, repoDir, maxBytes = DEFAULT_MAX_IMAGE_BYTES } = {}) {
  if (typeof imagePath !== 'string' || !imagePath.trim() || !repoDir) return null;
  const ref = imagePath.trim();
  const warn = (why) => {
    console.warn(`portal: skipping Image "${ref}" — ${why}.`);
    return null;
  };

  if (isAbsolute(ref)) return warn('absolute paths are not allowed');
  const mime = MIME[extname(ref).toLowerCase()];
  if (!mime) return warn(`unsupported type (allowed: ${Object.keys(MIME).join(', ')})`);

  const full = resolve(repoDir, ref);
  if (!within(repoDir, full)) return warn('path escapes the repository');
  if (!existsSync(full)) return warn('file not found');

  // Symlink-aware re-check: the REAL target must still be inside the repo.
  let realFull;
  let realRepo;
  try {
    realFull = realpathSync(full);
    realRepo = realpathSync(repoDir);
  } catch {
    return warn('could not resolve real path');
  }
  if (realFull !== realRepo && !within(realRepo, realFull)) {
    return warn('resolves outside the repository');
  }

  let bytes;
  try {
    bytes = readFileSync(realFull);
  } catch {
    return warn('could not read file');
  }
  if (!bytes.length) return warn('empty file');
  if (bytes.length > maxBytes) return warn(`too large (${bytes.length} > ${maxBytes} bytes)`);

  return `data:${mime};base64,${bytes.toString('base64')}`;
}
