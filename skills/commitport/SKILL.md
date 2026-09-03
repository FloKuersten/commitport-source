---
name: commitport
description: Use when writing a commit that a client should see, or when the user asks about client-facing progress updates, changelogs, release notes for non-technical stakeholders, or a client progress portal. Also use when a commitport build publishes nothing, publishes the wrong commits, or a client asks "what did you get done this week?".
---

# commitport — write commits your client can read

commitport turns the git commits you **mark** into a static, client-ready progress
portal, translating implementation into impact. It runs entirely locally against
the repo's own history: no network, no telemetry, nothing uploaded.

## The one workflow that matters: preview before committing

The most useful thing you can do is check the client-facing wording **before** the
commit exists, while it is still free to change.

When drafting a commit message for work a client should see:

1. Call `commitport_preview` with the subject line you are about to use.
2. Read `clientSees` — that is the exact sentence the client will read.
3. If it reads badly, fix the commit message (not the portal) and preview again.
4. Only then make the commit.

```
commitport_preview  subject: ":zap: perf(client): optimize database query indexing"
→ { publishes: true, clientSees: "Sped up data lookups", category: "Performance" }
```

If `publishes` is `false`, the `reason` says why — either nothing marked it as
client-facing, or an internal scope excluded it (which always wins, by design).

## The other job: "what did you get done this week?"

When the user needs to tell a client what shipped, call `commitport_client_update`
(optionally `days`). It returns only what has actually been **published** —
already translated into plain English and checked by the leak guard.

Never compose a client update from raw `git log` output. That leaks internal work
and reads as engineer-speak, which is the exact problem commitport exists to solve.
If the tool returns nothing, say so and run `commitport_doctor` — do not pad the
update with work the client was never shown.

## How a commit gets published

A commit reaches the client portal if **any** of these is true:

- it starts with a client-facing gitmoji — `:sparkles: :rocket: :ambulance: :bug: :lock: :zap: :memo: :lipstick:` …
- its scope is `(client)` or `(public)`
- its body carries a real `Client:` git trailer

The internal-scope denylist (`internal`, `ci`, `deps`, `build`, `test`) **beats
everything**, including a gitmoji or a trailer. Privacy always wins — never
suggest working around it.

### Choosing the wording

- **Automatic translation** handles ordinary commits: an offline dictionary swaps
  the engineer's verb and jargon for plain language.
- **A `Client:` trailer is published verbatim.** Use it whenever the exact wording
  matters — an outage explanation, a milestone, anything a client may quote back.

```bash
git commit -m "fix: null check in webhook handler" \
  -m "Client: Notifications now arrive reliably, even during high traffic."
```

- **Non-code milestones** (design sign-offs, approvals, calls) are real client
  progress. Log them as marked empty commits:

```bash
git commit --allow-empty -m ":handshake: chore(client): design sign-off" \
  -m "Client: Your homepage design is approved — development starts Monday."
```

## When something looks wrong

- **"It published nothing."** Run `commitport_doctor`. It distinguishes the
  causes — nothing marked, internal scope excluded it, or `publishMode:
  "explicit"` ignoring a lone gitmoji — and each needs a different fix. Do not
  guess; the tool tells you which one applies.
- **"Wrong commits appear."** `commitport_stats` shows published vs internal
  counts per category.
- **A build fails on the leak guard.** That is the guard doing its job: a
  client-facing message looks like it contains a token, password, email, or
  internal hostname. Fix it by rewording the commit or supplying a safe `Client:`
  trailer. Only add a `guard.allow` exception when the match is genuinely a false
  positive, and say so explicitly.

## Rules

- **Never invent client-facing text.** Every published line must come from a real
  commit. If wording needs to change, change the commit message.
- **Never suggest bypassing the internal-scope denylist or the leak guard** to get
  something published.
- `commitport_build` writes files; the other tools only read. Build into the
  project's own output directory unless the user names another.
- The portal is a read-only progress layer — it complements a client portal, it
  does not replace project management or two-way communication.

## Reference

CLI equivalents: `commitport init | build | build --watch | verify | stats | doctor`.
Config lives in `portal.config.json` (markers, dictionary, title, accent, per-client
`profiles`). Full docs: <https://commitport.com> · source:
<https://github.com/FloKuersten/commitport-source>

commitport is source-available, not OSI open source: reading, auditing, building
and evaluating are free; client, business, or production use requires a one-time
license from <https://commitport.com>.
