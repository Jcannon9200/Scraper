'use strict';

/**
 * Targeted Puppeteer re-fetch for news articles that have no publication date.
 * Re-scrapes only those pages — much faster than a full crawl.
 */

const crypto  = require('crypto');
const { Fetcher } = require('./src/fetcher');
const { scrape }  = require('./src/scraper');
const { getDb, closeDb } = require('./src/db');

const RATE_MS = 1200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = getDb();

  const articles = db.prepare(`
    SELECT url, title FROM pages
    WHERE  url  LIKE '%reformcalifornia.org/news/%'
    AND    url  NOT LIKE '%?%'
    ORDER  BY url
  `).all();

  console.log(`\nPatching dates for ${articles.length} news articles...\n`);

  const fetcher = new Fetcher({ headless: true, requestTimeout: 30000 });
  await fetcher.init();

  let updated = 0, failed = 0;

  for (const [i, row] of articles.entries()) {
    try {
      const html = await fetcher.get(row.url);
      if (!html) { failed++; continue; }

      const pageData     = scrape(html, row.url);
      const contentHash  = crypto.createHash('sha256').update(html).digest('hex');

      db.prepare(`
        UPDATE pages
        SET content = ?, content_hash = ?, title = ?, last_crawled = ?
        WHERE url = ?
      `).run(JSON.stringify(pageData), contentHash, pageData.title,
             pageData.crawledAt, row.url);

      const date = pageData.publicationDate ?? '(no date)';
      console.log(`[${i+1}/${articles.length}] ${date.padEnd(12)}  ${pageData.title?.slice(0,55)}`);
      updated++;
    } catch (err) {
      console.error(`[error] ${row.url}: ${err.message}`);
      failed++;
    }
    if (i < articles.length - 1) await sleep(RATE_MS);
  }

  await fetcher.close();

  // ── Show the 20 most recent ────────────────────────────────────────────────
  const rows = db.prepare(`
    SELECT url, title, content FROM pages
    WHERE  url LIKE '%reformcalifornia.org/news/%'
    AND    url NOT LIKE '%?%'
  `).all();

  const articles2 = rows
    .map(r => {
      let pub = null;
      try { pub = JSON.parse(r.content)?.publicationDate ?? null; } catch {}
      return { title: r.title, url: r.url, publicationDate: pub };
    })
    .filter(a => a.publicationDate)
    .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate))
    .slice(0, 20);

  const hr = '─'.repeat(74);
  console.log(`\n${hr}`);
  console.log('  20 MOST RECENT ARTICLES — reformcalifornia.org/news');
  console.log(hr);

  if (articles2.length === 0) {
    console.log('  No publication dates found. The site may store dates differently.');
  } else {
    articles2.forEach((a, i) => {
      console.log(`  ${String(i+1).padStart(2)}.  [${a.publicationDate}]  ${(a.title||'').slice(0,55)}`);
      console.log(`        ${a.url}\n`);
    });
  }

  console.log(hr);
  console.log(`  Updated: ${updated}  |  Failed: ${failed}  |  With dates: ${articles2.length}`);
  console.log(`${hr}\n`);

  closeDb();
})().catch(err => { console.error(err); process.exit(1); });
