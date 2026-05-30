const cheerio = require('cheerio');
const { URL } = require('url');

const SOCIAL_HOSTS = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 't.me',
  'threads.net', 'snapchat.com', 'tumblr.com',
]);

const MONTHS = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

// Normalise any recognised date string to YYYY-MM-DD for consistent sorting.
function normalizeDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // Already ISO: 2024-01-15T... or 2024-01-15
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // "May 11, 2026"  /  "May 11 2026"  /  "11 May 2026"
  const mdy = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy) {
    const m = MONTHS[mdy[1].toLowerCase()];
    if (m) return `${mdy[3]}-${String(m).padStart(2,'0')}-${String(mdy[2]).padStart(2,'0')}`;
  }
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (dmy) {
    const m = MONTHS[dmy[2].toLowerCase()];
    if (m) return `${dmy[3]}-${String(m).padStart(2,'0')}-${String(dmy[1]).padStart(2,'0')}`;
  }

  return s;
}

// CSS class fragments that reliably indicate a date element.
// Ordered from most to least specific.
const DATE_CLASS_RE = /\b(date[-_]?publish|publish[-_]?date|post[-_]?date|article[-_]?date|entry[-_]?date|date[-_]?container|date[-_]?posted|posted[-_]?date)\b/i;

// Looser fallback — catches "date" anywhere in the class string.
const DATE_WORD_RE = /\bdate\b/i;

// Text that looks like a standalone date (no other prose around it).
const DATE_TEXT_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$/i;

function extractPublicationDate($) {
  // 1 ── Standard meta / schema tags ────────────────────────────────────────
  const fromMeta =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="article:published_time"]').attr('content')     ||
    $('meta[property="datePublished"]').attr('content')          ||
    $('meta[itemprop="datePublished"]').attr('content')          ||
    $('meta[name="date"]').attr('content')                       ||
    $('meta[name="pubdate"]').attr('content')                    ||
    $('meta[name="DC.date"]').attr('content');
  if (fromMeta) return normalizeDate(fromMeta);

  // 2 ── Schema.org / <time> elements ───────────────────────────────────────
  const fromSchema =
    $('[itemprop="datePublished"]').attr('datetime')            ||
    $('[itemprop="datePublished"]').first().text().trim()       ||
    $('time[datetime]').first().attr('datetime')                ||
    $('time[pubdate]').first().attr('datetime');
  if (fromSchema) return normalizeDate(fromSchema);

  // 3 ── Class-based heuristic (most specific patterns first) ───────────────
  //      Only look at the element's own text (excluding child text) so we
  //      don't accidentally pick up surrounding prose.
  let found = null;

  $('[class]').each((_, el) => {
    if (found) return;
    const cls = $(el).attr('class') || '';
    if (!DATE_CLASS_RE.test(cls) && !DATE_WORD_RE.test(cls)) return;

    // Own text only (strip child element text)
    const text = $(el).clone().children().remove().end().text().trim();
    if (text.length >= 6 && text.length <= 40 && /\d{4}/.test(text)) {
      found = normalizeDate(text);
    }
  });
  if (found) return found;

  // 4 ── Last resort: any short leaf element whose entire text is a date ─────
  $('div, span, p, li').each((_, el) => {
    if (found) return;
    // Must be a leaf-like node (no block children)
    if ($(el).children('div, p, ul, ol, section, article').length) return;
    const text = $(el).text().trim();
    if (DATE_TEXT_RE.test(text)) found = normalizeDate(text);
  });

  return found;
}

function scrape(html, pageUrl) {
  const $ = cheerio.load(html);

  // Run date extraction before stripping scripts/styles (some sites embed
  // structured-data JSON-LD inside <script type="application/ld+json">)
  const publicationDate = extractPublicationDate($);

  $('script, style, noscript, iframe').remove();

  const title = $('title').first().text().trim();

  const metaDescription =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const text = $(el).text().trim();
    if (text) headings.push({ level: el.tagName.toLowerCase(), text });
  });

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  const images = [];
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    try {
      images.push({ src: new URL(src, pageUrl).href, alt: $(el).attr('alt') || '' });
    } catch { /* skip malformed src */ }
  });

  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('#') || href.startsWith('mailto:') ||
        href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const resolved = new URL(href, pageUrl);
      if (SOCIAL_HOSTS.has(resolved.hostname)) return;
      links.push({ href: resolved.href, text: $(el).text().trim() });
    } catch { /* skip malformed href */ }
  });

  return {
    url: pageUrl,
    crawledAt: new Date().toISOString(),
    title,
    metaDescription,
    publicationDate,
    headings,
    bodyText,
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    images,
    links,
  };
}

module.exports = { scrape };
