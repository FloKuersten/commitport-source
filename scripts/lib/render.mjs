// Phase 3 — Static generation.
// Takes the filtered + translated commit objects and emits three artifacts:
//   - data.json  : the structured, sanitized data source (the "database")
//   - index.html : a polished, client-facing timeline (precompiled CSS inlined)
//   - feed.xml   : an Atom feed so clients can subscribe in any feed reader
//                  (only when site.url is configured)
// Raw hashes and author emails never reach these files, and dates are
// published at day resolution only.

import { createHash } from 'node:crypto';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const xmlEsc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])
  );

const isHttpUrl = (u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

// Exported so check-css.mjs can verify coverage from the source of truth
// instead of regex-scraping this file.
export const CATEGORY_COLORS = {
  'New Feature':
    'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800',
  Deployment:
    'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-800',
  'Critical Fix':
    'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-800',
  Fix: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800',
  Security:
    'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800',
  Performance:
    'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800',
  Documentation:
    'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
  Design:
    'bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-950 dark:text-pink-300 dark:ring-pink-800',
  Localization:
    'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:ring-teal-800',
  Accessibility:
    'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-300 dark:ring-cyan-800',
  Update:
    'bg-gray-50 text-gray-700 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700',
};

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

/**
 * The sanitized public data source. This is the entire "backend".
 * Dates are published at DAY resolution only: second-resolution timestamps and
 * timezone offsets would fingerprint the team's working hours and locations.
 */
export function renderJSON(items, config, generatedAt) {
  return JSON.stringify(
    {
      title: config.site.title,
      subtitle: config.site.subtitle,
      generatedAt: dayKey(generatedAt),
      count: items.length,
      items: items.map((it) => ({
        date: dayKey(it.isoDate),
        emoji: it.emoji,
        category: it.category,
        message: it.message,
      })),
    },
    null,
    2
  );
}

/**
 * Atom feed — lets clients subscribe to progress in any feed reader.
 * Same privacy posture as data.json: day-resolution dates, no hashes, no
 * authors. Entry IDs are derived from day+message (never the commit hash,
 * which is private repo metadata).
 */
export function renderAtom(items, config, generatedAt) {
  const { site } = config;
  if (!isHttpUrl(site.url)) {
    throw new Error('renderAtom requires a valid http(s) site.url in the config');
  }
  // Normalize the trailing slash: new URL('feed.xml', '...//portal') would
  // resolve to the parent path and the self-link would 404.
  const base = new URL(site.url.endsWith('/') ? site.url : site.url + '/');
  const feedUrl = new URL('feed.xml', base).href;

  // RFC 4287 forbids duplicate atom:id values — two same-day commits can
  // translate to the identical message, so disambiguate with an occurrence
  // index (stable across rebuilds: input order is the sorted commit list).
  const seen = new Map();
  const entries = items
    .map((it) => {
      const day = dayKey(it.isoDate);
      const key = `${day}|${it.message}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const id =
        'urn:portal:' +
        createHash('sha256').update(`${key}|${n}`).digest('hex').slice(0, 24);
      return `  <entry>
    <id>${id}</id>
    <title>${xmlEsc(`${it.emoji} ${it.message}`)}</title>
    <updated>${day}T00:00:00Z</updated>
    <category term="${xmlEsc(it.category)}"/>
    <link rel="alternate" href="${xmlEsc(base.href)}"/>
    <content type="text">${xmlEsc(it.message)}</content>
  </entry>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEsc(site.title)}</title>
  <subtitle>${xmlEsc(site.subtitle)}</subtitle>
  <id>${xmlEsc(base.href)}</id>
  <link rel="self" href="${xmlEsc(feedUrl)}"/>
  <link rel="alternate" href="${xmlEsc(base.href)}"/>
  <author><name>${xmlEsc(site.title)}</name></author>
  <updated>${dayKey(generatedAt)}T00:00:00Z</updated>
${entries}
</feed>
`;
}

/**
 * The client-facing timeline. Static, fully self-contained: the precompiled
 * Tailwind subset (assets/portal.css) is inlined, so the page makes zero
 * network requests — no CDN, no JS, nothing to block or go down.
 * Honors prefers-color-scheme (dark mode) purely via compiled CSS.
 */
export function renderHTML(items, config, generatedAt, cssText = '') {
  const { site } = config;

  // The accent lands in a CSS context, where HTML-escaping is the wrong
  // defense — validate the shape instead and fall back to the default.
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(site.accent || '') ? site.accent : '#6366f1';

  // Defense in depth: the inlined stylesheet is our own committed asset, but a
  // </style> inside it would terminate the tag and turn CSS into markup.
  if (/<\/style/i.test(cssText)) {
    throw new Error('refusing to inline CSS containing "</style" (style-tag breakout)');
  }

  // Feed discovery link (the feed itself is only generated when site.url is a
  // valid http(s) URL — same gate here, and the href is a constant).
  const feedLink = isHttpUrl(site.url)
    ? `\n  <link rel="alternate" type="application/atom+xml" title="${esc(site.title)}" href="feed.xml" />`
    : '';

  // Group items by calendar day, newest first.
  const groups = new Map();
  for (const it of items) {
    const key = dayKey(it.isoDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const orderedDays = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));

  const timeline = orderedDays
    .map((day) => {
      const dayItems = groups.get(day);
      const cards = dayItems
        .map((it) => {
          const color = CATEGORY_COLORS[it.category] || CATEGORY_COLORS.Update;
          return `
          <li class="relative pl-10">
            <span class="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white text-lg shadow ring-1 ring-gray-200 dark:bg-slate-800 dark:ring-slate-700">${esc(
              it.emoji
            )}</span>
            <div class="rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-slate-700 dark:bg-slate-800">
              <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${color}">${esc(
                it.category
              )}</span>
              <p class="mt-2 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200">${esc(it.message)}</p>
            </div>
          </li>`;
        })
        .join('\n');

      return `
        <section class="mb-10">
          <h2 class="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">${esc(
            fmtDate(day + 'T12:00:00Z')
          )}</h2>
          <ul class="space-y-4 border-l border-dashed border-gray-200 pl-0 dark:border-slate-700">${cards}
          </ul>
        </section>`;
    })
    .join('\n');

  const empty = `
    <div class="rounded-xl border border-dashed border-gray-300 bg-white/60 p-10 text-center text-gray-500 dark:border-slate-600 dark:bg-slate-800/60 dark:text-gray-400">
      <p class="text-lg">No client-facing updates yet.</p>
      <p class="mt-1 text-sm">New milestones appear here automatically as work ships.</p>
    </div>`;

  return `<!doctype html>
<html lang="en" class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
  <meta name="referrer" content="no-referrer" />
  <meta name="color-scheme" content="light dark" />${feedLink}
  <title>${esc(site.title)}</title>
  <style>${cssText}</style>
  <style>
    :root { --accent: ${accent}; }
    body { background:
      radial-gradient(60rem 60rem at 110% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent),
      #f8fafc; }
    @media (prefers-color-scheme: dark) {
      body { background:
        radial-gradient(60rem 60rem at 110% -10%, color-mix(in srgb, var(--accent) 18%, transparent), transparent),
        #0b1120; }
    }
  </style>
</head>
<body class="min-h-full text-gray-900 antialiased dark:text-gray-100">
  <main class="mx-auto max-w-2xl px-5 py-14 sm:py-20">
    <header class="mb-12">
      <div class="mb-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-500 shadow-sm ring-1 ring-gray-100 dark:bg-slate-800 dark:text-gray-400 dark:ring-slate-700">
        <span class="h-2 w-2 rounded-full" style="background: var(--accent)"></span>
        Live progress feed
      </div>
      <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">${esc(site.title)}</h1>
      <p class="mt-3 text-lg text-gray-600 dark:text-gray-400">${esc(site.subtitle)}</p>
    </header>

    ${items.length ? timeline : empty}

    <footer class="mt-16 border-t border-gray-200 pt-6 text-sm text-gray-400 dark:border-slate-700 dark:text-gray-500">
      <p>${esc(site.footer || '')}</p>
      <p class="mt-1">Last updated ${esc(fmtDate(generatedAt))}.</p>
    </footer>
  </main>
</body>
</html>
`;
}
