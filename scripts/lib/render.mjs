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
 * Optional grouping. When config.groupByMessage is true, commits that produce
 * the SAME client-facing message on the SAME day are folded into one timeline
 * entry carrying a `count` (e.g. five "Fixed a reliability issue" commits in a
 * day become one line, shown as "×5"). Different days or different messages
 * stay separate. Input order is preserved — callers pass the already-sorted
 * (newest-first) list, so the first occurrence represents the group. Off by
 * default; returns the input untouched so existing portals are unchanged.
 */
export function collapseItems(items, { groupByMessage = false } = {}) {
  if (!groupByMessage) return items;
  const byKey = new Map();
  const out = [];
  for (const it of items) {
    // NUL separator is collision-proof: published text is stripped of control
    // characters (incl. NUL) upstream in parse-commits, so it can't appear here.
    const key = `${dayKey(it.isoDate)}\x00${it.category}\x00${it.message}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.count += 1;
      continue;
    }
    const entry = { ...it, count: 1 };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out;
}

/**
 * Assign each entry a stable, privacy-safe anchor id for deep-linking (e.g.
 * portal/#u-ab12…). Derived from day + message + occurrence index — NEVER the
 * commit hash (private repo metadata) — so it survives rebuilds and reveals
 * nothing. The same algorithm runs in every renderer, so the index.html anchor
 * and the data.json id always match. Exported for testing.
 */
export function assignEntryIds(items) {
  const seen = new Map();
  return items.map((it) => {
    const key = `${dayKey(it.isoDate)}|${it.message}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const id = 'u-' + createHash('sha256').update(`${key}|${n}`).digest('hex').slice(0, 16);
    return { ...it, id };
  });
}

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
      items: assignEntryIds(items).map((it) => ({
        id: it.id, // stable anchor: portal/#<id>
        date: dayKey(it.isoDate),
        emoji: it.emoji,
        category: it.category,
        message: it.message,
        // Only present (and > 1) when grouping folded duplicate commits, so a
        // single-commit entry's JSON shape is unchanged.
        ...(it.count > 1 ? { count: it.count } : {}),
        // Flag (not the bytes) so data.json stays lean; the image itself is
        // inlined into index.html only.
        ...(it.image ? { hasImage: true } : {}),
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
      const h = createHash('sha256').update(`${key}|${n}`).digest('hex');
      const id = 'urn:portal:' + h.slice(0, 24);
      // Deep-link the feed entry to the same anchor the portal + data.json use.
      const anchor = 'u-' + h.slice(0, 16);
      return `  <entry>
    <id>${id}</id>
    <title>${xmlEsc(`${it.emoji} ${it.message}`)}</title>
    <updated>${day}T00:00:00Z</updated>
    <category term="${xmlEsc(it.category)}"/>
    <link rel="alternate" href="${xmlEsc(base.href)}#${anchor}"/>
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
 * JSON Feed 1.1 (jsonfeed.org) — a standards-based feed automation tools
 * (Zapier, Slack, custom dashboards) consume without parsing XML. Same privacy
 * posture as the Atom feed: day-resolution dates, no hashes/authors; item ids
 * and urls use the shared anchor. Only emitted when site.url is configured.
 */
export function renderJsonFeed(items, config, generatedAt) {
  const { site } = config;
  if (!isHttpUrl(site.url)) {
    throw new Error('renderJsonFeed requires a valid http(s) site.url in the config');
  }
  const base = new URL(site.url.endsWith('/') ? site.url : site.url + '/');
  return (
    JSON.stringify(
      {
        version: 'https://jsonfeed.org/version/1.1',
        title: site.title,
        ...(site.subtitle ? { description: site.subtitle } : {}),
        home_page_url: base.href,
        feed_url: new URL('feed.json', base).href,
        items: assignEntryIds(items).map((it) => ({
          id: it.id,
          url: `${base.href}#${it.id}`,
          title: `${it.emoji} ${it.message}`,
          content_text: it.message,
          date_published: `${dayKey(it.isoDate)}T00:00:00Z`,
          tags: [it.category],
        })),
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * An index for a multi-client build. With config.profiles each client's portal
 * lands in its own folder and nothing ties them together — this is the agency's
 * own landing page listing them, written to the output root. It is NOT
 * client-facing: it names every client you serve, so it carries noindex and
 * should sit behind whatever auth the rest of your output does.
 */
export function renderProfilesIndex(profiles, config, generatedAt, cssText = '') {
  const { site } = config;
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(site.accent || '') ? site.accent : '#6366f1';
  if (/<\/style/i.test(cssText)) {
    throw new Error('refusing to inline CSS containing "</style" (style-tag breakout)');
  }
  const cards = profiles
    .map((p) => {
      const label = p.name || p.out;
      const n = Number(p.published) || 0;
      return `
        <li class="relative pl-10">
          <span aria-hidden="true" class="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white text-lg shadow ring-1 ring-gray-200 dark:bg-slate-800 dark:ring-slate-700">📁</span>
          <div class="rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-slate-700 dark:bg-slate-800">
            <p class="mt-2 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200"><a href="${esc(p.out)}/">${esc(label)}</a></p>
            <p class="mt-1 text-sm text-gray-400 dark:text-gray-500">${n} update${n === 1 ? '' : 's'} published</p>
          </div>
        </li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="${esc(site.lang || 'en')}" class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
  <meta name="referrer" content="no-referrer" />
  <meta name="color-scheme" content="light dark" />
  <title>${esc(site.title)} — client portals</title>
  <style>${cssText}</style>
  <style>
    :root { --accent: ${accent}; }
    body { background: #f8fafc; }
    @media (prefers-color-scheme: dark) { body { background: #0b1120; } }
  </style>
</head>
<body class="min-h-full text-gray-900 antialiased dark:text-gray-100">
  <main class="mx-auto max-w-2xl px-5 py-14 sm:py-20">
    <header class="mb-12">
      <div class="mb-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-500 shadow-sm ring-1 ring-gray-100 dark:bg-slate-800 dark:text-gray-400 dark:ring-slate-700">
        <span class="h-2 w-2 rounded-full" style="background: var(--accent)" aria-hidden="true"></span>
        ${profiles.length} client portal${profiles.length === 1 ? '' : 's'}
      </div>
      <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">${esc(site.title)}</h1>
      <p class="mt-3 text-lg text-gray-600 dark:text-gray-400">Every client portal generated from this repository.</p>
    </header>
    <ul class="space-y-4 border-l border-dashed border-gray-200 pl-0 dark:border-slate-700">${cards}
    </ul>
    <footer class="mt-16 border-t border-gray-200 pt-6 text-sm text-gray-400 dark:border-slate-700 dark:text-gray-500">
      <p>Internal index — it lists every client you serve, so don't hand this link to any one of them.</p>
      <p class="mt-1">Last updated ${esc(fmtDate(generatedAt))}.</p>
    </footer>
  </main>
</body>
</html>
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

  // Stable per-entry anchors so a client can be deep-linked to one update
  // (portal/#u-…); the same ids appear in data.json and the Atom feed.
  items = assignEntryIds(items);

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
    ? `\n  <link rel="alternate" type="application/atom+xml" title="${esc(site.title)}" href="feed.xml" />` +
      `\n  <link rel="alternate" type="application/feed+json" title="${esc(site.title)}" href="feed.json" />`
    : '';

  // Group items by calendar day. Newest-first by default; config.order
  // "oldest-first" reads the portal as a forward-moving journal (older -> newer).
  const oldestFirst = config.order === 'oldest-first';
  const groups = new Map();
  for (const it of items) {
    const key = dayKey(it.isoDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const orderedDays = [...groups.keys()].sort((a, b) =>
    a < b ? (oldestFirst ? -1 : 1) : oldestFirst ? 1 : -1
  );

  const timeline = orderedDays
    .map((day) => {
      const dayItems = oldestFirst ? [...groups.get(day)].reverse() : groups.get(day);
      const cards = dayItems
        .map((it) => {
          const color = CATEGORY_COLORS[it.category] || CATEGORY_COLORS.Update;
          return `
          <li id="${it.id}" class="relative pl-10">
            <span aria-hidden="true" class="absolute left-0 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white text-lg shadow ring-1 ring-gray-200 dark:bg-slate-800 dark:ring-slate-700">${esc(
              it.emoji
            )}</span>
            <div class="rounded-xl border border-gray-100 bg-white p-4 shadow-sm transition hover:shadow-md dark:border-slate-700 dark:bg-slate-800">
              <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${color}">${esc(
                it.category
              )}</span>${
                it.count > 1
                  ? ` <span class="text-xs text-gray-400 dark:text-gray-500">×${it.count}</span>`
                  : ''
              }
              <p class="mt-2 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200">${esc(it.message)}</p>${
                it.image
                  ? `\n              <img src="${it.image}" alt="" loading="lazy" style="margin-top:.6rem;max-width:100%;height:auto;border-radius:.5rem;display:block;border:1px solid rgba(100,116,139,.2)" />`
                  : ''
              }
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
<html lang="${esc(site.lang || 'en')}" class="h-full">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
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
    /* Print / "Save as PDF" — clients ask for a document they can file or
       forward, and the dark theme would otherwise follow them onto paper.
       Forces a light, ink-frugal layout, keeps each update whole across a page
       break, and prints the portal's address so the PDF says where it came
       from. Rules live here rather than in the Tailwind subset so no CSS
       rebuild is required. */
    @media print {
      @page { margin: 18mm 16mm; }
      html, body {
        background: #fff !important;
        color: #111 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      main { max-width: none !important; padding: 0 !important; }
      /* Cards keep their shape but drop shadows/tints that waste ink. */
      li > div {
        box-shadow: none !important;
        background: #fff !important;
        border: 1px solid #d4d4d8 !important;
      }
      li, section { break-inside: avoid; page-break-inside: avoid; }
      section > h2 { break-after: avoid; page-break-after: avoid; }
      img { max-width: 100% !important; }
      /* Day headings and body copy need real contrast on paper. */
      h1, h2, h3, p, span { color: #111 !important; }
      #print-url { display: block !important; }
    }
    #print-url { display: none; }
  </style>
</head>
<body class="min-h-full text-gray-900 antialiased dark:text-gray-100">
  <main class="mx-auto max-w-2xl px-5 py-14 sm:py-20">
    <header class="mb-12">${
      site.logoData
        ? `\n      <img src="${site.logoData}" alt="${esc(site.title)}" style="height:44px;width:auto;margin-bottom:1.25rem;display:block" />`
        : ''
    }
      <div class="mb-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-500 shadow-sm ring-1 ring-gray-100 dark:bg-slate-800 dark:text-gray-400 dark:ring-slate-700">
        <span class="h-2 w-2 rounded-full" style="background: var(--accent)" aria-hidden="true"></span>
        Live progress feed${
          items.length ? ` · ${items.length} update${items.length === 1 ? '' : 's'} shipped` : ''
        }
      </div>
      <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">${esc(site.title)}</h1>
      <p class="mt-3 text-lg text-gray-600 dark:text-gray-400">${esc(site.subtitle)}</p>
    </header>

    ${items.length ? timeline : empty}

    <footer class="mt-16 border-t border-gray-200 pt-6 text-sm text-gray-400 dark:border-slate-700 dark:text-gray-500">
      <p>${esc(site.footer || '')}</p>
      <p class="mt-1">Last updated ${esc(fmtDate(generatedAt))}.</p>${
        isHttpUrl(site.url) ? `
      <p id="print-url" class="mt-1">${esc(site.url)}</p>` : ''
      }${
        site.poweredBy === false
          ? ''
          : `\n      <p class="mt-1">Built with <a href="https://commitport.com" target="_blank" rel="noopener noreferrer" style="color: var(--accent)">commitport</a>.</p>`
      }
    </footer>
  </main>
</body>
</html>
`;
}
