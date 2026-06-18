#!/usr/bin/env node
// Rasterize assets/icon.svg into a multi-size Windows icon (assets/commitport.ico),
// used by `npm run build:exe` to brand commitport.exe. Re-run after editing the
// SVG. Build-time only (resvg + png-to-ico are devDependencies).
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(ROOT, 'assets/icon.svg'), 'utf8');

// Render each size from the vector independently so small sizes stay crisp.
const sizes = [256, 128, 64, 48, 32, 16];
const pngs = sizes.map((value) =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value }, background: 'rgba(0,0,0,0)' }).render().asPng())
);

const ico = await pngToIco(pngs);
const out = resolve(ROOT, 'assets/commitport.ico');
writeFileSync(out, ico);
console.log(`Wrote ${out}  (${(ico.length / 1024).toFixed(0)} KB, sizes: ${sizes.join('/')})`);
