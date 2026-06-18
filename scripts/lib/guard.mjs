// Leak guard — the last gate between "an engineer typed something into a commit
// message" and "it is on the public internet".
//
// Scans the final client-facing strings for secret material, credentials, PII,
// and internal infrastructure names. On any hit the build FAILS (rather than
// silently redacting): a human must look at it, amend the commit or rephrase,
// and rebuild. Matches are reported redacted so the secret is not echoed into
// CI logs either.

const PATTERNS = [
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'api-key-like', re: /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { name: 'password-assignment', re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i },
  { name: 'url-with-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
  { name: 'email-address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/ },
  { name: 'ip-address', re: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/ },
  { name: 'internal-hostname', re: /\b[A-Za-z0-9-]+\.(?:internal|local|corp|lan|intranet|localdomain)\b|\blocalhost\b/i },
  { name: 'ssh-pubkey', re: /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{40,}/ },
];

const redact = (s) => (s.length <= 8 ? s[0] + '***' : s.slice(0, 4) + '***' + s.slice(-2));

/**
 * Audit the strings that will be published. Returns a list of violations
 * (empty = clean). `allowPatterns` (from config.guard.allow) are regex strings
 * for deliberate exceptions, e.g. a public support email.
 */
export function auditPublishable(strings, allowPatterns = []) {
  const allow = allowPatterns.map((p) => new RegExp(p, 'i'));
  const violations = [];

  for (const text of strings) {
    if (typeof text !== 'string' || !text) continue;
    for (const { name, re } of PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      if (allow.some((a) => a.test(m[0]))) continue;
      // Redact the secret inside the context line too — otherwise the build
      // log itself would leak the very thing we refused to publish.
      // split/join, NOT .replace(string, string): a secret containing "$&"
      // would re-expand to the full match via replacement-pattern semantics,
      // and .replace only touches the first occurrence.
      const ctx = text.split(m[0]).join(redact(m[0]));
      violations.push({
        pattern: name,
        match: redact(m[0]),
        context: ctx.length > 80 ? ctx.slice(0, 77) + '...' : ctx,
      });
    }
  }
  return violations;
}

/**
 * Format violations for the build log without echoing the secret itself.
 */
export function formatViolations(violations) {
  const lines = violations.map(
    (v) => `  [${v.pattern}] matched "${v.match}" in: "${v.context}"`
  );
  return (
    'Leak guard: refusing to publish — the following client-facing text looks like it ' +
    'contains secrets, credentials, or internal details:\n' +
    lines.join('\n') +
    '\n\nFix the commit message (git commit --amend / rebase), use a Client: trailer with ' +
    'safe wording, or add a deliberate exception under "guard": { "allow": [...] } in ' +
    'config/portal.config.json.'
  );
}
