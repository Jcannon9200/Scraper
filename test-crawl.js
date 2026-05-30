const { Crawler } = require('./src/crawler');
const { getPageCount, getLastCrawlRun, resetDb, closeDb } = require('./src/db');

const hr = '─'.repeat(58);

(async () => {
  resetDb();
  console.log('DB wiped — starting from zero.\n');

  const TARGET  = 'https://quotes.toscrape.com';
  const OPTS    = { maxDepth: 2, rateLimitMs: 300 };
  const crawler = new Crawler(OPTS);

  // ── CRAWL 1 ────────────────────────────────────────────────
  console.log(hr);
  console.log('CRAWL 1  (cold start | maxDepth=2 | rateLimit=300ms)');
  console.log(hr);
  const t1start = Date.now();
  const r1 = await crawler.crawl(TARGET);
  const t1 = ((Date.now() - t1start) / 1000).toFixed(1);

  console.log(`\n${'▶'.repeat(3)} Run 1 complete in ${t1}s`);
  console.log(`   scraped : ${r1.pagesScraped}`);
  console.log(`   skipped : ${r1.pagesSkipped}`);
  console.log(`   errors  : ${r1.errorCount}`);
  console.log(`   db total: ${getPageCount()}`);

  // ── CRAWL 2 ────────────────────────────────────────────────
  console.log(`\n${hr}`);
  console.log('CRAWL 2  (incremental re-crawl | same URL + depth)');
  console.log(hr);
  const t2start = Date.now();
  const r2 = await crawler.crawl(TARGET);
  const t2 = ((Date.now() - t2start) / 1000).toFixed(1);

  console.log(`\n${'▶'.repeat(3)} Run 2 complete in ${t2}s`);
  console.log(`   scraped : ${r2.pagesScraped}`);
  console.log(`   skipped : ${r2.pagesSkipped}`);
  console.log(`   errors  : ${r2.errorCount}`);
  console.log(`   db total: ${getPageCount()}`);

  // ── VERDICT ───────────────────────────────────────────────
  const run2 = getLastCrawlRun();
  const allSkipped = r2.pagesScraped === 0 && r2.pagesSkipped === r1.pagesScraped;
  console.log(`\n${hr}`);
  console.log(`INCREMENTAL CRAWL: ${allSkipped ? '✓ WORKING' : '✗ CHECK RESULTS'}`);
  console.log(`  Run 1 scraped ${r1.pagesScraped} pages, stored in SQLite.`);
  console.log(`  Run 2 scraped ${r2.pagesScraped} pages, skipped ${r2.pagesSkipped} (ETag/hash match).`);
  console.log(`  Time saved: ~${(r1.pagesScraped * OPTS.rateLimitMs / 1000).toFixed(1)}s of redundant fetches avoided.`);
  console.log(hr);

  closeDb();
})().catch(err => { console.error(err); process.exit(1); });
