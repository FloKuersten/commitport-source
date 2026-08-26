// Phase 2 — The Translation Matrix (action -> impact).
// Converts an engineer's commit description into a client-facing impact
// statement. Fully deterministic and offline by default. An optional LLM hook
// is provided for polished phrasing, but it is never required and never runs
// unless explicitly enabled with a key present.
//
// Strategy:
//   1. A `Client:` trailer in the commit body is used verbatim (perfect control).
//   2. Otherwise: strip structural noise, swap the engineer's leading verb for a
//      friendly one (verbMap), map jargon to plain language (dictionary), collapse
//      accidental duplicate words, and present a single clean sentence. Acronyms
//      and proper casing are preserved.

// Structural noise (regex). Lexical removals live in config.dictionary as "".
const NOISE = [
  /`[^`]*`/g, // inline code spans
  /\([^)]*\)/g, // parenthetical asides
  /\bv?\d+\.\d+(?:\.\d+)?\b/gi, // bare version numbers
  /\bwip\b/gi,
  /^\s*the\s+/i,
];

const tidy = (s) =>
  s
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/^[\s,–-]+|[\s,–-]+$/g, '')
    .trim();

// Collapse consecutive identical words ("layout layout" -> "layout").
const dedupeWords = (s) => s.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');

// Common two-word (phrasal) verbs -> one friendly verb, matched BEFORE the
// single-word verbMap. Mapping only the leading word doubles the meaning:
// ":zap: speed up search" would take the category verb "Sped up" and keep
// "speed up" in the body -> "Sped up speed up search". Consuming the whole
// phrasal verb fixes it -> "Sped up search".
const PHRASAL_VERBS = {
  'speed up': 'Sped up',
  'clean up': 'Cleaned up',
  'set up': 'Set up',
  'roll out': 'Rolled out',
  'roll back': 'Rolled back',
  'lock down': 'Secured',
  'back up': 'Backed up',
  'scale up': 'Scaled',
  'spin up': 'Launched',
  'shut down': 'Retired',
  'lay out': 'Laid out',
};

/**
 * Optional first-person voice. With config.voice === 'we', a deterministic
 * message ("Launched the dashboard") becomes "We launched the dashboard": the
 * leading friendly verb (always a plain past-tense word, never an acronym) is
 * lowercased, the rest — acronyms, proper nouns — is untouched. Any other value,
 * including the default 'impersonal', is a no-op.
 */
const applyVoice = (message, voice) =>
  voice === 'we' && message ? 'We ' + message.charAt(0).toLowerCase() + message.slice(1) : message;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Apply the technical-term -> client-value dictionary. Longest phrases first so
 * multi-word entries ("session tokens") win over their sub-words ("tokens").
 * An empty-string mapping deletes the term.
 */
function applyDictionary(text, dictionary = {}) {
  const entries = Object.entries(dictionary).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [term, plain] of entries) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    out = out.replace(re, plain);
  }
  return out;
}

/**
 * Produce the final client-facing message for one classified commit.
 */
export function translate(commit, config) {
  if (commit.clientMessage) {
    return { message: commit.clientMessage, source: 'trailer' };
  }

  let text = commit.description || '';
  for (const re of NOISE) text = text.replace(re, ' ');
  text = tidy(text);

  // Split off a leading verb so we never stack two verbs ("Launched added ...").
  const verbMap = config.verbMap || {};
  const words = text.split(/\s+/).filter(Boolean);
  const firstKey = (words[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  const twoKey = words.slice(0, 2).join(' ').toLowerCase().replace(/[^a-z ]/g, '').trim();

  let verb;
  let rest;
  if (PHRASAL_VERBS[twoKey]) {
    verb = PHRASAL_VERBS[twoKey]; // engineer's phrasal verb, consumed whole
    rest = words.slice(2);
  } else if (verbMap[firstKey]) {
    verb = verbMap[firstKey]; // engineer's own verb, made friendly
    rest = words.slice(1);
  } else {
    verb = commit.verb || 'Updated'; // category verb (gitmoji/type)
    rest = words;
  }

  let body = applyDictionary(rest.join(' '), config.dictionary);
  body = dedupeWords(tidy(body));

  let message = body ? `${verb} ${body}` : verb;
  message = dedupeWords(tidy(message));
  message = message.charAt(0).toUpperCase() + message.slice(1);
  message = applyVoice(message, config.voice);

  return { message, source: 'dictionary' };
}

/**
 * Build the AI user-message content. When a changed-files summary is attached
 * (commit.changes — paths + line counts, NOT the code diff), include it so the
 * model has real context for terse messages like "wip" or "fixed stuff".
 * Truncated to keep the request small. Exported for testing.
 */
export function aiUserContent(commit) {
  const base = `${commit.type || ''}: ${commit.description}`;
  const changes = commit.changes ? String(commit.changes).trim() : '';
  return changes ? `${base}\n\nChanged files (for context):\n${changes.slice(0, 800)}` : base;
}

/**
 * Optional AI polish (build-time). Disabled unless `enableAI` is true AND an
 * ANTHROPIC_API_KEY is present in the environment. Falls back silently to the
 * deterministic result on any error, so a build never breaks because of it.
 *
 * Left as a clearly-marked integration point rather than a hard dependency,
 * keeping the portal genuinely zero-secret by default.
 */
export async function translateWithAI(commit, config, { enableAI = false } = {}) {
  const deterministic = translate(commit, config);
  if (!enableAI || !process.env.ANTHROPIC_API_KEY || commit.clientMessage) {
    return deterministic;
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 120,
        system:
          'You rewrite a single software commit into ONE short, non-technical, ' +
          'benefit-focused sentence for a client. Describe user impact, not ' +
          'implementation. No jargon, no commit prefixes, no quotes. Max 16 words. ' +
          'You may be given a list of changed files for context — use it to infer ' +
          'the user-facing impact when the message itself is terse.' +
          (config.voice === 'we' ? " Write in the first person plural, starting with 'We '." : ''),
        messages: [{ role: 'user', content: aiUserContent(commit) }],
      }),
    });
    if (!res.ok) return deterministic;
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    // The "short sentence" contract is prompt-level only — enforce it in code.
    // Reject oversized output, URLs/emails (shouldn't appear in client copy),
    // and anything multi-line; fall back to the deterministic result.
    const acceptable =
      text &&
      text.length <= 140 &&
      !text.includes('\n') &&
      !/https?:\/\/|@/.test(text);
    return acceptable ? { message: text, source: 'ai' } : deterministic;
  } catch {
    return deterministic;
  }
}
