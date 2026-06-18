// The commitport app window. When commitport.exe is double-clicked (or run as
// `commitport gui`), this starts a tiny localhost server and opens it in a
// chromeless browser window — a friendly UI to pick a repo and generate a
// portal. No Node, no install; everything runs on the user's machine.
//
// Security (localhost desktop app): bound to 127.0.0.1 only; every /api/* call
// requires a per-launch random token (a web page can't read it cross-origin)
// and a localhost Host header (blocks DNS-rebinding). All OS calls (folder
// dialog, open, generate) pass paths as argv array elements with shell:false,
// so a folder name can never inject a command.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { generatePortal, starterConfig } from './generate.mjs';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Is `child` the same as, or contained within, `parent`? Used to keep all writes
// and "open" targets inside the user's selected project folder (no path escape).
function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function page(token, defaultRepo) {
  // __REPO__ lands in an HTML attribute (backslashes are literal there); __TOKEN__
  // is hex (safe inside a JS string). esc() neutralizes any HTML metacharacters.
  return PAGE.replace(/__TOKEN__/g, token).replace(/__REPO__/g, esc(defaultRepo));
}

// --- OS helpers (all shell-free: paths are argv elements, never interpolated) ---

function pickFolder() {
  return new Promise((res) => {
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "$d.Description='Select your project folder (a git repository)';" +
      "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}";
    let out = '';
    try {
      const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true });
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => res(out.trim() || null));
      p.on('error', () => res(null));
    } catch {
      res(null);
    }
  });
}

function openPath(p) {
  // explorer opens a folder, or a file in its default app (index.html -> browser).
  try {
    spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* best effort */
  }
}

function openAppWindow(url) {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    ...bases.map((b) => join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...bases.map((b) => join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ];
  const bin = candidates.find((p) => existsSync(p));
  try {
    if (bin) {
      spawn(bin, [`--app=${url}`, '--window-size=920,760'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* user can open the printed URL manually */
  }
}

// Reads a small JSON body. On overflow, sends 413 and resolves null (caller must
// stop). On parse/socket error, resolves {} / null.
function readJson(req, res, cap = 1 << 16) {
  return new Promise((done) => {
    let buf = '';
    let over = false;
    req.on('data', (c) => {
      buf += c;
      if (buf.length > cap && !over) {
        over = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"error":"payload too large"}');
        } catch {
          /* ignore */
        }
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return done(null);
      try {
        done(JSON.parse(buf || '{}'));
      } catch {
        done({});
      }
    });
    req.on('error', () => done(null));
  });
}

export function launchGui() {
  const token = process.env.COMMITPORT_GUI_TOKEN || randomBytes(16).toString('hex');
  const noOpen = process.env.COMMITPORT_GUI_NO_OPEN === '1';
  const fixedPort = Number(process.env.COMMITPORT_GUI_PORT) || 0;
  // Pre-fill the folder only if we were launched inside a git repo (e.g. a CLI
  // user running `commitport` in their project); otherwise start blank so the
  // Start-menu/installed launch doesn't suggest the install directory.
  const cwd = process.cwd();
  const defaultRepo = existsSync(join(cwd, '.git')) ? cwd : '';

  let lastPing = Date.now();
  let pinged = false;
  const started = Date.now();
  // Folders the user just generated into — the only paths /api/open may reveal.
  let lastRoots = [];

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = String(req.headers.host || '');
    // Anti-DNS-rebinding: only answer to a localhost Host.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page(token, defaultRepo));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // Token gate. Header for fetch; query for sendBeacon (ping/quit only).
      const supplied = req.headers['x-cpt-token'] || url.searchParams.get('t') || '';
      if (supplied !== token) {
        json(res, 403, { error: 'bad token' });
        return;
      }
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
        json(res, 403, { error: 'bad origin' });
        return;
      }

      if (url.pathname === '/api/ping') {
        lastPing = Date.now();
        pinged = true;
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/quit') {
        json(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      if (url.pathname === '/api/pick-folder') {
        const p = await pickFolder();
        json(res, 200, { path: p });
        return;
      }

      const body = await readJson(req, res);
      if (body === null) return; // 413 already sent, or socket gone

      if (url.pathname === '/api/open') {
        // Only open paths inside a folder we just generated into (server-chosen
        // values), never an arbitrary client-supplied path.
        const p = String(body.path || '');
        const allowed = Boolean(p) && existsSync(p) && lastRoots.some((root) => within(root, resolve(p)));
        if (allowed) openPath(p);
        json(res, allowed ? 200 : 403, { ok: allowed });
        return;
      }

      if (url.pathname === '/api/init') {
        const repo = String(body.repo || '');
        if (!repo || !existsSync(repo) || !statSync(repo).isDirectory()) {
          json(res, 400, { error: 'Pick a valid project folder first.' });
          return;
        }
        const dest = join(repo, 'portal.config.json');
        if (existsSync(dest)) {
          json(res, 200, { ok: true, path: dest, existed: true });
          return;
        }
        try {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(dest, starterConfig());
          json(res, 200, { ok: true, path: dest });
        } catch (e) {
          json(res, 500, { error: e.message });
        }
        return;
      }

      if (url.pathname === '/api/generate') {
        const repo = String(body.repo || '');
        if (!repo || !existsSync(repo) || !statSync(repo).isDirectory()) {
          json(res, 400, { ok: false, error: 'Pick a valid project folder first.' });
          return;
        }
        if (!existsSync(join(repo, '.git'))) {
          json(res, 400, { ok: false, error: 'That folder is not a git repository (no .git found).' });
          return;
        }
        // Keep output + config inside the project — never let a client-supplied
        // path write or read outside the chosen repo.
        const outAbs = resolve(repo, String(body.out || '').trim() || 'public');
        if (!within(repo, outAbs)) {
          json(res, 400, { ok: false, error: 'Output folder must be inside the project folder.' });
          return;
        }
        let configPath;
        const cfgRaw = String(body.config || '').trim();
        if (cfgRaw) {
          const cfgAbs = resolve(repo, cfgRaw);
          if (!within(repo, cfgAbs)) {
            json(res, 400, { ok: false, error: 'Config file must be inside the project folder.' });
            return;
          }
          configPath = cfgAbs;
        }
        const lines = [];
        const log = (m) => lines.push(String(m));
        try {
          const r = await generatePortal({ repo, out: outAbs, configPath, ai: Boolean(body.ai), log });
          lastRoots = [resolve(repo), r.outDir];
          json(res, 200, { ok: true, log: lines.join('\n'), ...r });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message, log: lines.join('\n') });
        }
        return;
      }

      json(res, 404, { error: 'not found' });
      return;
    }

    res.writeHead(404).end('Not found');
  });

  // Exit when the window closes (pings stop) or if it never opened at all.
  setInterval(() => {
    const now = Date.now();
    if (pinged && now - lastPing > 12_000) process.exit(0);
    if (!pinged && now - started > 90_000) process.exit(0);
  }, 3_000).unref();

  server.listen(fixedPort, '127.0.0.1', () => {
    const port = server.address().port;
    // No token in the URL/stdout — the page injects it server-side, so this
    // tokenless link still works and the token never lands in logs/history.
    const link = `http://127.0.0.1:${port}/`;
    console.log(`commitport is running at ${link}`);
    console.log('(Close the window to quit. This window can be minimized.)');
    if (!noOpen) openAppWindow(link);
  });
}

// ---------------------------------------------------------------------------
// The UI. __TOKEN__ / __REPO__ are substituted per launch. The client script
// uses string concatenation (no template literals) so this server-side template
// literal has no nested ${} to escape.
const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>commitport</title>
<style>
:root{--accent:#6366f1;--accent2:#8b5cf6;--ink:#0f172a;--muted:#64748b;--line:#e6e8ee;--bg:#f7f8fc;--card:#fff;--ok:#059669;--no:#ef4444}
@media(prefers-color-scheme:dark){:root{--ink:#e7ecf5;--muted:#9aa6bd;--line:#23304d;--bg:#070b16;--card:#0e1626}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.wrap{max-width:640px;margin:0 auto;padding:1.6rem 1.4rem 2.4rem}
.top{display:flex;align-items:center;gap:.6rem;margin-bottom:1.2rem}
.top b{font-size:1.05rem;font-weight:600;letter-spacing:-.01em}
h1{font-size:1.45rem;line-height:1.25;margin:.2rem 0 .3rem;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 1.4rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.2rem 1.2rem 1.3rem;box-shadow:0 20px 40px -28px rgba(2,6,23,.28)}
label{display:block;font-weight:600;font-size:.9rem;margin:0 0 .35rem}
.row{display:flex;gap:.5rem}
input[type=text]{flex:1;width:100%;padding:.62rem .7rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit}
input[type=text]:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:1px;border-color:transparent}
.hint{color:var(--muted);font-size:.8rem;margin:.35rem 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;border:0;border-radius:11px;background:var(--accent);color:#fff;font:inherit;font-weight:600;padding:.66rem 1rem;cursor:pointer}
.btn:hover{filter:brightness(1.05)}.btn:disabled{opacity:.6;cursor:default}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.btn.lg{width:100%;padding:.85rem;font-size:1.02rem;margin-top:1.1rem}
.muted{color:var(--muted)}
details{margin-top:1.1rem;border-top:1px solid var(--line);padding-top:.5rem}
summary{cursor:pointer;font-weight:600;font-size:.9rem;color:var(--muted);padding:.4rem 0}
.adv{padding:.4rem 0 .2rem}.adv label{margin-top:.8rem}
.chk{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;font-size:.86rem;color:var(--muted);margin-top:.9rem}
.chk input{margin-top:.18rem}
#result{margin-top:1.1rem;display:none}
.res-ok{border:1px solid color-mix(in srgb,var(--ok) 40%,var(--line));background:color-mix(in srgb,var(--ok) 8%,transparent);border-radius:12px;padding:.9rem 1rem}
.res-no{border:1px solid color-mix(in srgb,var(--no) 45%,var(--line));background:color-mix(in srgb,var(--no) 8%,transparent);border-radius:12px;padding:.9rem 1rem;color:var(--no)}
.res-ok b{font-size:1.02rem}.stat{color:var(--muted);font-size:.88rem;margin:.25rem 0 .8rem}
.res-actions{display:flex;gap:.5rem;flex-wrap:wrap}
pre#log{margin:.8rem 0 0;background:#0b1020;color:#9fb3d1;border-radius:10px;padding:.8rem;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:230px;overflow:auto;display:none}
.foot{color:var(--muted);font-size:.78rem;margin:1.3rem 0 0;text-align:center}
.spin{width:15px;height:15px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;display:inline-block;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap">
<div class="top">
<svg width="30" height="30" viewBox="0 0 256 256" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="256" height="256" rx="60" fill="url(#g)"/><g stroke="#fff" stroke-width="18" stroke-linecap="round" fill="#fff"><line x1="98" y1="72" x2="98" y2="184"/><line x1="98" y1="128" x2="168" y2="86"/><circle cx="98" cy="72" r="19"/><circle cx="98" cy="184" r="19"/><circle cx="168" cy="86" r="21"/></g><circle cx="98" cy="128" r="31" fill="#fff"/><circle cx="98" cy="128" r="13" fill="url(#g)"/></svg>
<b>commitport</b>
</div>
<h1>Turn your commits into a client portal</h1>
<p class="sub">Point it at your project, click generate. Your clients get a clean, plain-English progress page — built from the work you already did.</p>
<div class="card">
<label for="repo">Project folder</label>
<div class="row"><input type="text" id="repo" value="__REPO__" placeholder="C:\\path\\to\\your\\repo" spellcheck="false"><button class="btn ghost" id="browse" type="button">Browse…</button></div>
<p class="hint">The git repository with your commits.</p>
<button class="btn lg" id="gen" type="button">Generate portal</button>
<div id="result"></div>
<details id="adv"><summary>Advanced</summary><div class="adv">
<label for="out">Output folder <span class="muted" style="font-weight:400">(where the portal is written)</span></label>
<input type="text" id="out" placeholder="(defaults to <project>\\public)" spellcheck="false">
<label for="config" style="margin-top:.9rem">Config file <span class="muted" style="font-weight:400">(optional)</span></label>
<div class="row"><input type="text" id="config" placeholder="(uses portal.config.json, or a built-in default)" spellcheck="false"><button class="btn ghost" id="initBtn" type="button">Create config</button></div>
<label class="chk"><input type="checkbox" id="ai"><span>AI polish — rewrite commit messages more fluently (needs an API key set in your config; off uses the built-in dictionary).</span></label>
<button class="btn ghost" id="logBtn" type="button" style="margin-top:.9rem;font-size:.85rem;padding:.45rem .8rem">Show full log</button>
<pre id="log"></pre>
</div></details>
</div>
<p class="foot">Runs entirely on your machine — nothing is uploaded. Requires git installed.</p>
</div>
<script>
var CPT={token:"__TOKEN__"};
function api(path,body,useQuery){
  var url=path+(useQuery?('?t='+CPT.token):'');
  var opts={method:'POST',headers:{'Content-Type':'application/json'}};
  if(!useQuery)opts.headers['x-cpt-token']=CPT.token;
  if(body)opts.body=JSON.stringify(body);
  return fetch(url,opts).then(function(r){return r.json()});
}
var $=function(id){return document.getElementById(id)};
var repo=$('repo'),out=$('out'),cfg=$('config'),gen=$('gen'),result=$('result'),log=$('log');
var last={};
$('browse').onclick=function(){
  api('/api/pick-folder').then(function(r){ if(r&&r.path){repo.value=r.path; if(!out.value)out.placeholder='(defaults to '+r.path+'\\\\public)';} });
};
$('initBtn').onclick=function(){
  if(!repo.value){flash('Pick a project folder first.',true);return;}
  api('/api/init',{repo:repo.value}).then(function(r){
    if(r.error)flash(r.error,true); else flash(r.existed?'A config already exists in that folder.':'Created portal.config.json in your folder.',false);
  });
};
$('logBtn').onclick=function(){ log.style.display=log.style.display==='block'?'none':'block'; };
gen.onclick=function(){
  if(!repo.value){flash('Pick a project folder first.',true);return;}
  gen.disabled=true; gen.innerHTML='<span class="spin"></span> Generating…'; result.style.display='none';
  api('/api/generate',{repo:repo.value,out:out.value,config:cfg.value,ai:$('ai').checked}).then(function(r){
    gen.disabled=false; gen.textContent='Generate portal';
    last=r; log.textContent=r.log||'';
    result.style.display='block';
    if(r.ok){
      result.innerHTML='<div class="res-ok"><b>✓ Portal generated</b><div class="stat">Published '+r.published+' update'+(r.published===1?'':'s')+' · '+r.dropped+' internal commit'+(r.dropped===1?'':'s')+' kept private</div><div class="res-actions"><button class="btn" id="op">Open portal</button> <button class="btn ghost" id="of">Open folder</button></div></div>';
      $('op').onclick=function(){api('/api/open',{path:r.indexPath})};
      $('of').onclick=function(){api('/api/open',{path:r.outDir})};
    } else {
      result.innerHTML='<div class="res-no"><b>Couldn\\'t generate</b><div style="margin-top:.3rem">'+escapeHtml(r.error||'Unknown error')+'</div></div>';
      if(r.log){log.style.display='block';}
    }
  }).catch(function(){ gen.disabled=false; gen.textContent='Generate portal'; flash('Something went wrong. See the log.',true); });
};
function flash(msg,bad){ result.style.display='block'; result.innerHTML='<div class="'+(bad?'res-no':'res-ok')+'">'+escapeHtml(msg)+'</div>'; }
function escapeHtml(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
setInterval(function(){api('/api/ping',null,true)},4000); api('/api/ping',null,true);
window.addEventListener('beforeunload',function(){ try{navigator.sendBeacon('/api/quit?t='+CPT.token)}catch(e){} });
</script></body></html>`;
