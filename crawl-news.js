'use strict';

const { Crawler } = require('./src/crawler');
const { getDb, closeDb } = require('./src/db');

(async () => {
  console.log('\nStarting headless crawl of /news (maxDepth:2, rateLimit:1500ms)...\n');

  const crawler = new Crawler({
    maxDepth:     2,
    rateLimitMs:  1500,
    headless:     true,
    forceRefresh: true,  // bypass ETag/hash cache so Puppeteer re-fetches everything
    urlFilters: {
      allowedDomains: ['www.reformcalifornia.org', 'reformcalifornia.org'],
      excludePatterns: [
        /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|ico|xml|zip|woff|woff2|ttf|eot|mp4|mp3)$/i,
        /\/(wp-admin|wp-login|wp-json|xmlrpc\.php)/i,
        /\/feed\/?(\?.*)?$/i,
        /[?&](s|search|q)=/i,
        /[?&]utm_/i,
      ],
    },
  });

  const result = await crawler.crawl('https://www.reformcalifornia.org/news');

  console.log(`\nCrawl done — ${result.pagesScraped} scraped, ${result.pagesSkipped} skipped, ${result.errorCount} errors\n`);

  // Pull every /news/ article that has a publication date from the KB
  const db    = getDb();
  const rows  = db.prepare(`
    SELECT url, title, content
    FROM   pages
    WHERE  url LIKE '%reformcalifornia.org/news/%'
    ORDER  BY last_crawled DESC
  `).all();

  const articles = rows
    .map(row => {
      let pub = null;
      try { pub = JSON.parse(row.content)?.publicationDate ?? null; } catch {}
      return { url: row.url, title: row.title, publicationDate: pub };
    })
    .filter(a => a.publicationDate)          // only articles with a parsed date
    .sort((a, b) => b.publicationDate.localeCompare(a.publicationDate))
    .slice(0, 20);

  const hr = '─'.repeat(72);
  console.log(hr);
  console.log('  20 MOST RECENT ARTICLES  (reformcalifornia.org/news)');
  console.log(hr);

  if (articles.length === 0) {
    // Fallback: show most recent by crawl order even without parsed dates
    console.log('  No publication dates parsed — showing most recently crawled:\n');
    const fallback = rows.slice(0, 20);
    fallback.forEach((a, i) => {
      console.log(`  ${String(i + 1).padStart(2)}.  ${(a.title || '(no title)').slice(0, 65)}`);
      console.log(`        ${a.url}\n`);
    });
  } else {
    articles.forEach((a, i) => {
      const date  = (a.publicationDate || '').slice(0, 10);
      const title = (a.title || '(no title)').slice(0, 62);
      console.log(`  ${String(i + 1).padStart(2)}.  [${date}]  ${title}`);
      console.log(`        ${a.url}\n`);
    });
  }

  console.log(hr);
  console.log(`  Total news articles in KB with dates: ${articles.length}`);
  console.log(hr + '\n');

  closeDb();
})().catch(err => { console.error(err); process.exit(1); });
