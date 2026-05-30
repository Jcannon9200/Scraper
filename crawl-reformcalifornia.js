/**
 * Targeted crawl of reformcalifornia.org with post-crawl knowledge base analysis.
 */

'use strict';

const { URL } = require('url');
const { Crawler } = require('./src/crawler');
const { getDb, closeDb } = require('./src/db');

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET = 'https://www.reformcalifornia.org/';

const OPTS = {
  maxDepth: 3,
  rateLimitMs: 1500,
  urlFilters: {
    // Accept both www and bare domain
    allowedDomains: ['www.reformcalifornia.org', 'reformcalifornia.org'],
    excludePatterns: [
      // Binary / media files
      /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|ico|xml|zip|gz|tar|woff|woff2|ttf|eot|mp4|mp3|avi|mov|wmv|doc|docx|xls|xlsx|ppt|pptx)$/i,
      // WordPress internals
      /\/(wp-admin|wp-login|wp-cron|wp-json|xmlrpc\.php)/i,
      // RSS / Atom feeds
      /\/feed\/?(\?.*)?$/i,
      // Search result pages
      /[?&](s|search|q|query)=/i,
      // Comment reply links
      /[?&]replytocom=/i,
      /\/comment-page-\d+/i,
      // Social share redirect paths
      /\/(share|go\/(twitter|facebook|instagram))/i,
      // Tracking / UTM clutter
      /[?&]utm_/i,
    ],
  },
};

// ─── Categorisation ───────────────────────────────────────────────────────────

const CATEGORIES = [
  { name: 'News / Press',   patterns: [/\/news\b/, /\/blog\b/, /\/press\b/, /\/article/, /\/press-release/] },
  { name: 'Campaigns',      patterns: [/\/campaign/] },
  { name: 'Petitions',      patterns: [/\/petition/, /\/sign\b/] },
  { name: 'Issues / Policy',patterns: [/\/issue/, /\/policy/, /\/policies/, /\/initiative/] },
  { name: 'Events',         patterns: [/\/event/] },
  { name: 'About',          patterns: [/\/about/, /\/team/, /\/staff/, /\/board/, /\/leadership/, /\/who-we-are/] },
  { name: 'Donate / Support',patterns: [/\/donat/, /\/give\b/, /\/support\b/, /\/contribute/] },
  { name: 'Contact / Legal',patterns: [/\/contact/, /\/privacy/, /\/terms/, /\/disclaimer/] },
  { name: 'Homepage',       patterns: [/^\/?$/] },
];

function categorize(url) {
  const path = new URL(url).pathname.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.patterns.some(re => re.test(path))) return cat.name;
  }
  return 'Other';
}

function topSection(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts.length === 0 ? '/' : `/${parts[0]}/`;
}

// ─── Summary printer ─────────────────────────────────────────────────────────

function printSummary(pages, crawlResult) {
  const hr  = '═'.repeat(62);
  const hr2 = '─'.repeat(62);

  console.log(`\n${hr}`);
  console.log('  KNOWLEDGE BASE SUMMARY — reformcalifornia.org');
  console.log(hr);

  const totalWords = pages.reduce((s, p) => {
    try { return s + (JSON.parse(p.content)?.wordCount ?? 0); } catch { return s; }
  }, 0);

  const pagesWithDates = pages.filter(p => {
    try { return !!JSON.parse(p.content)?.publicationDate; } catch { return false; }
  });

  console.log(`  Pages crawled        : ${pages.length}`);
  console.log(`  Words indexed        : ${totalWords.toLocaleString()}`);
  console.log(`  Pages with pub dates : ${pagesWithDates.length}`);
  console.log(`  Scrape errors        : ${crawlResult.errorCount}`);
  console.log(`  Finished at          : ${crawlResult.finishedAt}`);

  // ── Content categories ──────────────────────────────────────────────────────
  const byCat = {};
  for (const p of pages) {
    const cat = categorize(p.url);
    byCat[cat] = (byCat[cat] || 0) + 1;
  }

  console.log(`\n${hr2}`);
  console.log('  CONTENT CATEGORIES');
  console.log(hr2);
  const sortedCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats) {
    const bar = '█'.repeat(Math.round(count / pages.length * 30));
    console.log(`  ${cat.padEnd(22)} ${String(count).padStart(4)}  ${bar}`);
  }

  // ── Top-level sections ──────────────────────────────────────────────────────
  const bySec = {};
  for (const p of pages) {
    const sec = topSection(p.url);
    bySec[sec] = (bySec[sec] || 0) + 1;
  }

  console.log(`\n${hr2}`);
  console.log('  TOP-LEVEL SECTIONS');
  console.log(hr2);
  const sortedSecs = Object.entries(bySec).sort((a, b) => b[1] - a[1]);
  for (const [sec, count] of sortedSecs) {
    console.log(`  ${sec.padEnd(35)} ${String(count).padStart(4)} page(s)`);
  }

  // ── Recent content (pages with publication dates) ────────────────────────────
  if (pagesWithDates.length > 0) {
    const dated = pagesWithDates
      .map(p => {
        const c = JSON.parse(p.content);
        return { url: p.url, title: p.title || '(no title)', date: c.publicationDate };
      })
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 10);

    console.log(`\n${hr2}`);
    console.log('  MOST RECENT CONTENT (by publication date)');
    console.log(hr2);
    for (const item of dated) {
      const dateStr = (item.date || '').slice(0, 10).padEnd(12);
      const titleStr = item.title.slice(0, 48).padEnd(48);
      console.log(`  ${dateStr}  ${titleStr}`);
      console.log(`              ${item.url}`);
    }
  }

  // ── Errors ──────────────────────────────────────────────────────────────────
  if (crawlResult.errors.length > 0) {
    console.log(`\n${hr2}`);
    console.log('  CRAWL ERRORS');
    console.log(hr2);
    for (const e of crawlResult.errors) {
      console.log(`  [depth:${e.depth}] ${e.error.padEnd(12)}  ${e.url}`);
    }
  }

  console.log(`\n${hr}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nStarting crawl of ${TARGET}`);
  console.log(`  maxDepth   : ${OPTS.maxDepth}`);
  console.log(`  rateLimit  : ${OPTS.rateLimitMs}ms`);
  console.log(`  domains    : ${OPTS.urlFilters.allowedDomains.join(', ')}`);
  console.log('');

  const crawler  = new Crawler(OPTS);
  const result   = await crawler.crawl(TARGET);

  // Query only reformcalifornia.org pages from the KB
  const db    = getDb();
  const pages = db.prepare(`
    SELECT url, title, last_crawled, content
    FROM   pages
    WHERE  url LIKE '%reformcalifornia.org%'
    ORDER  BY last_crawled DESC
  `).all();

  printSummary(pages, result);
  closeDb();
})().catch(err => { console.error(err); process.exit(1); });
