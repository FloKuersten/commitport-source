// Which commits SHOULD the client have seen?
//
// The rest of commitport is passive: you mark a commit, it publishes. That
// leaves the most common real failure untouched — you shipped something the
// client would care about and simply forgot to mark it, so it silently never
// reaches them. This finds those: unmarked commits whose Conventional Commit
// type says the change is user-visible.
//
// Deliberately conservative, because a false suggestion is worse than a missed
// one here — acting on it publishes something to a client:
//   - the internal-scope denylist is absolute; those are never suggested, and
//     an agent must never be nudged toward overriding it;
//   - only feat / fix / perf qualify (docs, refactor, chore, style, test and
//     build describe work a client has no view of);
//   - anything that already publishes is skipped;
//   - anything the leak guard would reject is dropped, so a suggestion can
//     never talk someone into publishing a secret.
//
// Pure and dependency-injected so it can be exercised without git or disk.

/** Conventional Commit types that describe a change a client can perceive. */
const CLIENT_VISIBLE_TYPES = new Set(['feat', 'fix', 'perf']);

/**
 * @param {object[]} parsed      every parsed commit in range
 * @param {object}   config      the portal config
 * @param {object}   deps        { classify, translate, auditPublishable }
 * @param {number}   [deps.limit]  cap on returned suggestions (default 10)
 * @returns {{suggestions: object[], scanned: number, alreadyMarked: number}}
 */
export function suggestMarks(parsed, config, { classify, translate, auditPublishable, limit = 10 } = {}) {
  const internal = config.internalScopes || [];
  const typeMap = config.typeMap || {};
  const suggestions = [];
  let alreadyMarked = 0;

  for (const commit of parsed) {
    if (classify(commit, config)) {
      alreadyMarked += 1;
      continue; // already reaches the client
    }
    // Privacy wins, always — never suggest surfacing an internal-scoped commit.
    if (commit.scope && internal.includes(commit.scope)) continue;
    if (!CLIENT_VISIBLE_TYPES.has(commit.type)) continue;

    // Preview it exactly as a marked commit of this type would render, so the
    // suggestion shows the real client-facing sentence rather than a guess.
    const meta = typeMap[commit.type] || {};
    const asMarked = {
      ...commit,
      emoji: meta.emoji || '',
      category: meta.category || 'Update',
      verb: meta.verb || 'Updated',
    };
    const { message } = translate(asMarked, config);
    if (!message) continue;

    // parseCommit keeps type/scope/description, not the raw subject line, so
    // rebuild the header the user would recognise in their own log.
    const subject = `${commit.type}${commit.scope ? `(${commit.scope})` : ''}: ${commit.description}`;

    // A suggestion that would trip the guard must never be shown: acting on it
    // would publish a secret.
    if (auditPublishable && auditPublishable([message], config.guard?.allow ?? [], config.guard?.deny ?? []).length) {
      continue;
    }

    suggestions.push({
      subject,
      date: String(commit.isoDate || '').slice(0, 10),
      type: commit.type,
      wouldRead: message,
      category: asMarked.category,
      // The smallest edit that publishes it, in the project's own convention.
      howToMark: meta.emoji
        ? `prefix it with a client gitmoji: "${shortcodeFor(config, commit.type)} ${subject}"`
        : `give it a client scope: "${commit.type}(client): ${commit.description}"`,
    });
    if (suggestions.length >= limit) break;
  }

  return { suggestions, scanned: parsed.length, alreadyMarked };
}

/** The gitmoji shortcode whose typeMap entry matches this type, if any. */
function shortcodeFor(config, type) {
  const target = (config.typeMap || {})[type]?.emoji;
  for (const [code, meta] of Object.entries(config.gitmojiMap || {})) {
    if (meta.emoji === target) return code;
  }
  return ':sparkles:';
}

/** Render suggestions for a terminal or an agent. */
export function formatSuggestions({ suggestions, scanned, alreadyMarked }) {
  if (!suggestions.length) {
    return `commitport: nothing to suggest — ${alreadyMarked} of ${scanned} commit(s) already publish, and the rest describe work a client has no view of.`;
  }
  const lines = suggestions.map(
    (s) => `  ${s.date}  ${s.subject}\n      would read: ${s.wouldRead}\n      to publish: ${s.howToMark}`
  );
  return [
    `commitport: ${suggestions.length} unmarked commit(s) look client-facing (${alreadyMarked} of ${scanned} already publish):`,
    '',
    ...lines,
    '',
    'These are suggestions from the commit type alone — you decide what the client sees. Amend or re-commit with a marker to publish one.',
  ].join('\n');
}
