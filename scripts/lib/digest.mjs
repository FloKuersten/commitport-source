// Shareable update — the distribution layer. Clients don't check portals or use
// RSS; they revert to email. So at build time we emit two extra artifacts from
// the SAME data the portal uses, with zero backend and zero network:
//   - email.html : a self-contained, inline-styled snippet the agency pastes
//                  into their own mail client (Gmail/Outlook-safe: tables +
//                  inline styles, no <style>, no external resources).
//   - update.md  : a plain markdown/text block to paste into email, Slack, etc.
// commitport never sends anything — it just hands you the update to send.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

const fmtDate = (day) =>
  new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

const isHttpUrl = (u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

export const DIGEST_DAYS = 7;

/**
 * The items to feature in a shareable update: everything within the last
 * `days` days, counting back from the newest item. Covers both daily and
 * weekly reporting cadences without any "since last send" state to track.
 * Input is the already-sorted (newest-first) list.
 */
export function recentItems(items, days = DIGEST_DAYS) {
  if (!items.length) return [];
  const newest = Date.parse(dayKey(items[0].isoDate) + 'T00:00:00Z');
  const cutoff = newest - (days - 1) * 86400000;
  return items.filter((it) => Date.parse(dayKey(it.isoDate) + 'T00:00:00Z') >= cutoff);
}

/** A plain-text/markdown update block — paste into email, Slack, a message. */
export function renderUpdateMarkdown(items, config, generatedAt) {
  const { site } = config;
  const day = items.length ? dayKey(items[0].isoDate) : dayKey(generatedAt);
  const lines = items.map(
    (it) => `- ${it.emoji} **${it.category}** — ${it.message}${it.count > 1 ? ` (×${it.count})` : ''}`
  );
  let md = `**${site.title} — progress update (${fmtDate(day)})**\n\n`;
  md += items.length ? lines.join('\n') : '_No new updates in this period._';
  if (isHttpUrl(site.url)) md += `\n\nSee the full timeline: ${site.url}`;
  return md + '\n';
}

/**
 * A self-contained "latest updates" widget for embedding on the agency's own
 * site (`<iframe src="embed.html">`). A full minimal HTML page with its own
 * styles, zero JS, no external resources, dark-mode aware; items deep-link to
 * the portal. `items` should already carry anchor ids.
 */
export function renderEmbed(items, config, generatedAt, { limit = 5 } = {}) {
  const { site } = config;
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(site.accent || '') ? site.accent : '#6366f1';
  const linkBase = isHttpUrl(site.url) ? esc(site.url) : '';
  const lang = esc(site.lang || 'en');
  const day = items.length ? dayKey(items[0].isoDate) : dayKey(generatedAt);
  const rows = items
    .slice(0, limit)
    .map((it) => {
      const label = `<span style="font-size:15px">${esc(it.emoji)}</span> <strong style="font-weight:600">${esc(
        it.category
      )}</strong> <span style="opacity:.85">${esc(it.message)}</span>`;
      const li =
        linkBase && it.id
          ? `<a href="${linkBase}#${it.id}" style="color:inherit;text-decoration:none">${label}</a>`
          : label;
      return `      <li style="padding:7px 0;border-top:1px solid var(--cp-line);font-size:14px;line-height:1.45">${li}</li>`;
    })
    .join('\n');
  const more = linkBase
    ? `\n    <a href="${linkBase}" style="display:inline-block;margin-top:10px;font-size:13px;font-weight:600;color:${accent};text-decoration:none">View all updates &rarr;</a>`
    : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(site.title)} — latest updates</title>
<style>
  :root{--cp-bg:#fff;--cp-fg:#1a1a1a;--cp-muted:#667085;--cp-line:#e6e8ee}
  @media(prefers-color-scheme:dark){:root{--cp-bg:#0e1626;--cp-fg:#e7ecf5;--cp-muted:#9aa6bd;--cp-line:#23304d}}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:var(--cp-fg);background:var(--cp-bg)}
  .cp{max-width:540px;padding:16px 18px}
  .cp h3{margin:0 0 2px;font-size:15px}
  .cp .sub{margin:0 0 10px;font-size:12px;color:var(--cp-muted)}
  .cp ul{list-style:none;margin:0;padding:0}
  .cp li:first-child{border-top:0}
  .cp a:hover{opacity:.8}
</style>
</head>
<body>
  <div class="cp">
    <h3>${esc(site.title)}</h3>
    <p class="sub">Latest updates &middot; ${esc(fmtDate(day))}</p>
    <ul>
${rows || '      <li style="padding:7px 0;font-size:14px;color:var(--cp-muted)">No updates yet.</li>'}
    </ul>${more}
  </div>
</body>
</html>
`;
}

/**
 * A self-contained HTML email snippet. Inline styles + a presentation table so
 * it survives Gmail/Outlook; no <style> block, no external images or links
 * beyond the optional portal URL. The agency copies it into their mail client.
 */
export function renderEmailHtml(items, config, generatedAt) {
  const { site } = config;
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(site.accent || '') ? site.accent : '#6366f1';
  const day = items.length ? dayKey(items[0].isoDate) : dayKey(generatedAt);
  // When the portal URL is set and entries carry anchor ids, deep-link each row
  // to its specific update (portal/#u-…); otherwise render plain text.
  const linkBase = isHttpUrl(site.url) ? esc(site.url) : '';
  const rows = items
    .map((it) => {
      const label = `<strong style="color:#555">${esc(it.category)}</strong> &mdash; ${esc(it.message)}${
        it.count > 1 ? ` <span style="color:#999">(&times;${it.count})</span>` : ''
      }`;
      const body =
        linkBase && it.id
          ? `<a href="${linkBase}#${it.id}" style="color:#1a1a1a;text-decoration:none">${label}</a>`
          : label;
      return `
      <tr><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:15px;color:#1a1a1a;line-height:1.5">
        <span style="font-size:16px">${esc(it.emoji)}</span>
        ${body}
      </td></tr>`;
    })
    .join('');
  const cta = isHttpUrl(site.url)
    ? `\n    <p style="margin:20px 0 0;font-size:15px"><a href="${esc(
        site.url
      )}" style="color:${accent};text-decoration:none;font-weight:600">See the full progress portal &rarr;</a></p>`
    : '';
  return `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <h2 style="margin:0 0 2px;font-size:20px;color:#111;line-height:1.3">${esc(site.title)}</h2>
    <p style="margin:0 0 16px;font-size:13px;color:#888">Progress update &middot; ${esc(fmtDate(day))}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">${
      rows || '<tr><td style="color:#888;font-size:15px">No new updates in this period.</td></tr>'
    }
    </table>${cta}
  </div>
`;
}
