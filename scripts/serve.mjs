#!/usr/bin/env node
// Tiny static preview server for the generated portal. Dev convenience only —
// the deployed artifact is just files on a CDN / GitHub Pages, no server needed.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, process.argv[2] || 'public');
const PORT = Number(process.env.PORT) || 8080;
// Dev preview only — never expose beyond this machine.
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
    const file = resolve(DIR, '.' + path);
    // Containment: must be DIR itself or strictly inside it. A bare startsWith
    // would also pass sibling directories like "public-evil".
    if (file !== DIR && !file.startsWith(DIR + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, HOST, () => {
  console.log(`Previewing ${DIR} at http://${HOST}:${PORT}`);
});
