// `commitport mcp` — a Model Context Protocol server over stdio, so an AI
// assistant (Claude Code, Cursor, anything MCP-capable) can drive commitport:
// check what would publish, preview a commit's client-facing translation, run
// doctor, build the portal, and verify published output.
//
// Zero-dependency by design, like the rest of commitport: MCP's stdio
// transport is newline-delimited JSON-RPC 2.0, which is ~150 lines to speak
// directly. stdout carries ONLY protocol messages; all logging goes to stderr.
//
// No network, no telemetry: every tool call is a local read of the user's git
// history with the same pipeline the CLI uses. Dependencies are INJECTED by
// generate.mjs (deps object) so this module imports nothing from it — no
// import cycle, and the protocol core stays unit-testable with stubs.

const PROTOCOL_FALLBACK = '2025-06-18';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Tool definitions: name, what an agent should know, and the input schema. */
function toolList() {
  const repoProp = {
    repo: {
      type: 'string',
      description: 'Path to the git repository (defaults to the current working directory).',
    },
    config: {
      type: 'string',
      description:
        'Path to a portal.config.json (defaults to <repo>/portal.config.json when present, else the built-in starter config).',
    },
  };
  return [
    {
      name: 'commitport_preview',
      title: 'Preview a commit as your client will read it',
      annotations: {
        title: 'Preview a commit as your client will read it',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Preview what one commit message would look like on the client portal — whether it publishes at all, and the plain-English translation a client would read. Use before committing to check wording.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'The commit subject line, e.g. ":sparkles: feat(client): add CSV export".',
          },
          clientNote: {
            type: 'string',
            description:
              'Optional Client: trailer text — published verbatim when present (overrides the automatic translation).',
          },
          ...repoProp,
        },
        required: ['subject'],
      },
    },
    {
      name: 'commitport_stats',
      title: 'Summarize what would publish',
      annotations: {
        title: 'Summarize what would publish',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Summarize what the repository would publish: totals (published / internal / scanned) and a per-category breakdown. Read-only.',
      inputSchema: { type: 'object', properties: repoProp },
    },
    {
      name: 'commitport_doctor',
      title: 'Diagnose the portal setup',
      annotations: {
        title: 'Diagnose the portal setup',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Diagnose the setup and explain problems before a build: why nothing would publish, what the secret leak-guard would block, misconfigured client profiles, missing stylesheet or public URL. Read-only.',
      inputSchema: { type: 'object', properties: repoProp },
    },
    {
      name: 'commitport_build',
      title: 'Build the client portal',
      annotations: {
        title: 'Build the client portal',
        // Writes generated files into the output directory. It only ever
        // rewrites commitport's own output, so it is not destructive, and
        // rebuilding is deterministic — same commits, same bytes.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Generate the client portal (index.html, data.json, feeds, the ready-to-send email + update block) from the repository. Writes files into the output directory.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProp,
          out: {
            type: 'string',
            description: 'Output directory (defaults to <repo>/public).',
          },
        },
      },
    },
    {
      name: 'commitport_client_update',
      title: 'Draft the client update',
      annotations: {
        title: 'Draft the client update',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Answer "what did you get done?" — returns the published, client-facing updates from the last N days as a ready-to-send markdown block. Use this when the user needs to tell a client what shipped, rather than composing an update from raw commits (which would leak internal work and engineer-speak).',
      inputSchema: {
        type: 'object',
        properties: {
          days: {
            type: 'integer',
            minimum: 1,
            maximum: 365,
            description: 'How many days back to cover, counting from the newest published update (default 7).',
          },
          ...repoProp,
        },
      },
    },
    {
      name: 'commitport_verify',
      title: 'Verify published output',
      annotations: {
        title: 'Verify published output',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        'Re-check a built portal against its manifest.json: confirms the published files are byte-for-byte what commitport generated. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          out: { type: 'string', description: 'The portal output directory to verify.' },
        },
        required: ['out'],
      },
    },
  ];
}

/**
 * MCP prompts — surfaced by clients as ready-made actions (a slash command in
 * Claude, an entry in Cursor). These are the two jobs people actually have:
 * tell a client what shipped, and word a commit so it reads well when it does.
 */
const PROMPTS = [
  {
    name: 'client_update',
    title: "Draft this week's client update",
    description:
      'Draft the update to send a client, from what has actually been published — not from raw commits.',
    arguments: [
      { name: 'days', description: 'How many days to cover (default 7).', required: false },
      { name: 'client', description: 'Client or project name, if the repo serves several.', required: false },
    ],
  },
  {
    name: 'client_ready_commit',
    title: 'Write a client-ready commit message',
    description:
      'Write a commit message for work a client should see, and check how it will read to them before committing.',
    arguments: [
      { name: 'work', description: 'What you changed, in your own words.', required: true },
    ],
  },
];

function promptMessages(name, args = {}) {
  if (name === 'client_update') {
    const days = args.days || '7';
    const who = args.client ? ` for ${args.client}` : '';
    return {
      description: `Draft a client update${who} covering the last ${days} days`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Draft the progress update I should send my client${who}, covering the last ${days} days.

` +
              `Use the commitport_client_update tool with days=${days} — it returns only what has actually been ` +
              `published to the client portal, already translated into plain English and checked by the leak guard. ` +
              `Do NOT compose the update from raw git log output: that would leak internal work and read as engineer-speak.

` +
              `Then present it as a short message I can send: a one-line summary of the period, the updates themselves, ` +
              `and a closing line. Keep my client's technical level in mind — plain language, impact not implementation. ` +
              `Do not invent anything that is not in the tool's output; if it looks thin, say so rather than padding it.`,
          },
        },
      ],
    };
  }
  return {
    description: 'Write a commit message a client can read',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `I changed: ${args.work || '(describe the change)'}

` +
            `Write a Conventional Commit message for this that will publish to my client portal — so it needs a ` +
            `client marker: a gitmoji (:sparkles: :bug: :zap: :lock: …), a (client) scope, or a Client: trailer.

` +
            `Before you settle on it, call commitport_preview with the subject to see the exact sentence my client ` +
            `will read. If that sentence reads badly, change the commit message and preview again. If the wording ` +
            `really matters, put the exact sentence in a Client: trailer — that is published verbatim.

` +
            `Give me the final git command, and show me the client-facing line it produces.`,
        },
      },
    ],
  };
}

/**
 * The protocol core. `deps` supplies everything with side effects, so tests can
 * stub any of it. Returns handle(msg) -> response object, or null when the
 * message needs no reply (notifications).
 */
export function createMcpCore(deps) {
  const {
    version = '2.0.0',
    cwd = process.cwd(),
    existsSync,
    joinPath,
    loadConfig,
    validateConfig,
    mergeVocabPacks,
    readGitLog,
    parseCommit,
    classify,
    translate,
    auditPublishable,
    statsReport,
    diagnose,
    formatReport,
    generateAll,
    verifyManifest,
    readAsset,
    recentItems,
    renderUpdateMarkdown,
  } = deps;

  // Resolve the effective config for a tool call: explicit path > repo-local
  // portal.config.json > packaged starter config. Vocab packs merge exactly as
  // the CLI does, so previews match real builds.
  function configFor(args = {}) {
    const repo = args.repo || cwd;
    let cfg;
    if (args.config) cfg = loadConfig(args.config);
    else if (existsSync(joinPath(repo, 'portal.config.json')))
      cfg = loadConfig(joinPath(repo, 'portal.config.json'));
    else cfg = JSON.parse(readAsset('portal.config.json', 'config/portal.config.json'));
    validateConfig(cfg);
    if (cfg.vocabPacks?.length) cfg.dictionary = mergeVocabPacks(cfg.dictionary, cfg.vocabPacks);
    return { cfg, repo };
  }

  function pipeline(args = {}) {
    const { cfg, repo } = configFor(args);
    const raw = readGitLog({
      sinceTag: cfg.range?.sinceTag ?? null,
      after: cfg.range?.after ?? null,
      before: cfg.range?.before ?? null,
      includePaths: cfg.includePaths ?? [],
      cwd: repo,
    });
    const parsed = raw.map(parseCommit);
    const classified = parsed.map((c) => classify(c, cfg)).filter(Boolean);
    return { cfg, repo, raw, parsed, classified };
  }

  const tools = {
    commitport_preview(args) {
      if (!args || typeof args.subject !== 'string' || !args.subject.trim()) {
        return errText('subject is required — the commit subject line to preview.');
      }
      const { cfg } = configFor(args);
      const commit = parseCommit({
        hash: '0'.repeat(40),
        isoDate: new Date().toISOString(),
        subject: args.subject,
        clientTrailer: typeof args.clientNote === 'string' && args.clientNote.trim() ? args.clientNote.trim() : null,
        imageTrailer: null,
        body: '',
      });
      const item = classify(commit, cfg);
      if (!item) {
        const internal = commit.scope && (cfg.internalScopes || []).includes(commit.scope);
        return text(
          JSON.stringify(
            {
              publishes: false,
              reason: internal
                ? `scope "${commit.scope}" is on the internal denylist — this never publishes, by design`
                : 'no client marker (no client gitmoji, client scope, or Client: trailer) — stays internal',
            },
            null,
            2
          )
        );
      }
      const t = translate(item, cfg);
      const guard = auditPublishable([t.message], cfg.guard?.allow ?? [], cfg.guard?.deny ?? []);
      return text(
        JSON.stringify(
          {
            publishes: guard.length === 0,
            ...(guard.length ? { blockedBy: 'leak guard — the message looks like it contains a secret or internal detail' } : {}),
            emoji: item.emoji,
            category: item.category,
            clientSees: t.message,
            source: t.source,
          },
          null,
          2
        )
      );
    },

    commitport_stats(args) {
      const { raw, classified } = pipeline(args);
      return text(JSON.stringify(statsReport(classified, raw.length), null, 2));
    },

    commitport_doctor(args) {
      const { cfg, parsed, classified, raw } = pipeline(args);
      const messages = classified.map((c) => translate(c, cfg).message);
      const guardHits = auditPublishable(messages, cfg.guard?.allow ?? [], cfg.guard?.deny ?? []);
      let hasCss = true;
      try {
        readAsset('portal.css', 'assets/portal.css');
      } catch {
        hasCss = false;
      }
      const report = diagnose({ config: cfg, parsed, classified, scanned: raw.length, hasCss, guardHits });
      return report.ok ? text(formatReport(report)) : errText(formatReport(report));
    },

    async commitport_build(args = {}) {
      const repo = args.repo || cwd;
      const out = args.out || joinPath(repo, 'public');
      const lines = [];
      const res = await generateAll({
        repo,
        out,
        configPath: args.config, // undefined -> generateAll's own default
        // stdout belongs to the protocol; capture build logs instead.
        log: (m) => lines.push(String(m)),
      });
      return text(
        `${lines.join('\n')}\n\npublished: ${res.published}` +
          (res.outDir ? `\noutput: ${res.outDir}` : '')
      );
    },

    commitport_client_update(args = {}) {
      const { cfg, classified } = pipeline(args);
      if (!classified.length) {
        return text(
          'Nothing client-facing has been published in this repository yet, so there is no update to send. Run commitport_doctor to see why.'
        );
      }
      const items = classified.map((c) => ({ ...c, message: translate(c, cfg).message }));
      // The guard runs here too: an update drafted from commits must clear the
      // same bar as one written to the portal.
      const blocked = auditPublishable(
        items.map((i) => i.message),
        cfg.guard?.allow ?? [],
        cfg.guard?.deny ?? []
      );
      if (blocked.length) {
        return errText(
          `The leak guard blocked ${blocked.length} message(s) — an update drafted from these would expose a secret, credential, email, or internal hostname. Reword the commit, or publish safe wording via a Client: trailer, before sending anything to a client.`
        );
      }
      const days = Number.isInteger(args.days) ? args.days : 7;
      const recent = recentItems(items, days);
      if (!recent.length) {
        return text(`No client-facing updates in the last ${days} day(s). Try a larger "days" value.`);
      }
      const stamp = recent[0].isoDate || new Date().toISOString();
      return text(
        `${renderUpdateMarkdown(recent, cfg, stamp)}

---
${recent.length} update(s) over the last ${days} day(s). This text is generated from published commits — send it as-is, or adjust the wording in the commits it came from.`
      );
    },

    commitport_verify(args) {
      if (!args || typeof args.out !== 'string' || !args.out.trim()) {
        return errText('out is required — the portal directory to verify.');
      }
      const r = verifyManifest(args.out);
      if (r.ok) return text(`verified ${r.checked} file(s) — all match manifest.json.`);
      return errText(
        `verification FAILED:\n` + r.mismatches.map((m) => `  - ${m.name}: ${m.reason}`).join('\n')
      );
    },
  };

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Not a request we can answer; only reply if it carried an id.
      return msg && msg.id !== undefined ? rpcError(msg.id, -32600, 'Invalid request') : null;
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'commitport', version },
          instructions:
            'commitport turns marked git commits into a client-ready progress portal. ' +
            'Use commitport_preview to check how a commit message would read to a client before committing, ' +
            'commitport_stats / commitport_doctor to inspect a repository, commitport_build to generate the portal, ' +
            'and commitport_verify to prove published output matches. Everything runs locally; nothing leaves the machine.',
        });
      case 'ping':
        return isNotification ? null : rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolList() });
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: PROMPTS });
      case 'prompts/get': {
        const name = params?.name;
        if (!PROMPTS.some((p) => p.name === name)) {
          return rpcError(id, -32602, `Unknown prompt: ${name}`);
        }
        return rpcResult(id, promptMessages(name, params?.arguments || {}));
      }
      case 'tools/call': {
        const name = params?.name;
        const fn = tools[name];
        if (!fn) return rpcError(id, -32602, `Unknown tool: ${name}`);
        try {
          const result = await fn(params?.arguments || {});
          return rpcResult(id, result);
        } catch (err) {
          // Tool failures are results, not protocol errors — the agent should
          // read them and adapt, not see the connection break.
          return rpcResult(id, errText(`${name} failed: ${err.message}`));
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized etc.
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

/** The stdio loop: newline-delimited JSON-RPC in, same out. */
export function runMcp(deps) {
  const handle = createMcpCore(deps);
  process.stderr.write('commitport mcp: ready (stdio)\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
        );
        continue;
      }
      Promise.resolve(handle(msg)).then((res) => {
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
