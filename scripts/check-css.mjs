#!/usr/bin/env node
// Asserts that every Tailwind class the renderer can emit exists in the
// precompiled assets/portal.css. Run after changing classes in render.mjs,
// then regenerate the CSS (see scripts/build-css note in README).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(ROOT, 'assets/portal.css'), 'utf8');

const sources = ['scripts/lib/render.mjs']
  .map((f) => readFileSync(resolve(ROOT, f), 'utf8'))
  .join(' ');

const tokens = new Set();
// class="..." attributes inside template literals; strip ${...} interpolations
// rather than skipping the attribute, so static classes around them are checked.
for (const m of sources.matchAll(/class="([^"]+)"/g)) {
  m[1]
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .forEach((t) => t && tokens.add(t));
}
// CATEGORY_COLORS — imported from the renderer itself, so this check can never
// drift from the source (regex-scraping broke on formatting changes).
const { CATEGORY_COLORS } = await import('./lib/render.mjs');
for (const classList of Object.values(CATEGORY_COLORS)) {
  classList.split(/\s+/).forEach((t) => t && tokens.add(t));
}

// A class name appears in CSS with :, /, [, ], . backslash-escaped.
const cssSelector = (t) => '.' + t.replace(/([:./[\]])/g, '\\$1');

const missing = [...tokens].filter((t) => !css.includes(cssSelector(t)));

console.log(`distinct classes emitted by render.mjs: ${tokens.size}`);
if (missing.length) {
  console.error('MISSING from assets/portal.css: ' + missing.join(', '));
  process.exit(1);
}
console.log('ALL CLASSES COVERED by assets/portal.css');
