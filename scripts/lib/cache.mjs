// Translation cache for --ai. Keyed by commit hash + voice, it lets repeated
// builds (watch mode, or CI on every push) skip re-calling the API for
// unchanged commits — saving time and the user's API spend. It stores only the
// public translated message (never secrets or diffs), lives in the repo as
// .commitport-cache.json, and is safe to commit (shared reuse in CI) or ignore.
// A commit's hash uniquely identifies its content, so an amended commit gets a
// new hash and re-translates; changing `voice` changes the key too.

import { readFileSync, writeFileSync } from 'node:fs';

export const cacheKey = (hash, voice) => `${hash}|${voice || 'impersonal'}`;

/** Load the entries map, or {} if the file is missing or malformed. */
export function loadCache(path) {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    return o && o.entries && typeof o.entries === 'object' ? o.entries : {};
  } catch {
    return {};
  }
}

/** Persist the entries map. Never throws — a cache write failure isn't fatal. */
export function saveCache(path, entries) {
  try {
    writeFileSync(path, JSON.stringify({ tool: 'commitport', version: 1, entries }, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}
