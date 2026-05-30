const fs = require('fs');
const path = require('path');
const express = require('express');
const { Crawler } = require('./crawler');
const { getDiff } = require('./monitor');
const { getPageByUrl, listPages, getPageCount, getLastCrawlRun, resetDb,
        searchPages, countFilteredPages } = require('./db');
const config = require('../config');

const router = express.Router();

// In-memory job registry — resets on server restart, DB persists
const jobs = new Map();
let jobCounter = 0;

// POST /crawl
// Body: { url?, maxDepth?, rateLimitMs?, headless? }
router.post('/crawl', (req, res) => {
  const { url = config.startUrl, maxDepth, rateLimitMs, headless, forceRefresh } = req.body || {};
  const jobId = `job_${++jobCounter}_${Date.now()}`;
  const useHeadless     = headless      === true || headless      === 'true';
  const useForceRefresh = forceRefresh  === true || forceRefresh  === 'true';

  const job = { id: jobId, status: 'running', startedAt: new Date().toISOString(), url, fetchMode: useHeadless ? 'puppeteer' : 'axios' };
  jobs.set(jobId, job);

  const crawler = new Crawler({
    maxDepth:     maxDepth   !== undefined ? parseInt(maxDepth,   10) : undefined,
    rateLimitMs:  rateLimitMs!== undefined ? parseInt(rateLimitMs,10) : undefined,
    headless:     useHeadless,
    forceRefresh: useForceRefresh,
  });

  res.status(202).json({
    jobId,
    status: 'running',
    url,
    fetchMode: useHeadless ? 'puppeteer' : 'axios',
    message: `Crawl started. Poll GET /crawl/${jobId} for status.`,
  });

  crawler
    .crawl(url)
    .then(result => {
      Object.assign(job, { status: 'done', finishedAt: result.finishedAt, result });
    })
    .catch(err => {
      Object.assign(job, { status: 'error', error: err.message });
    });
});

// GET /crawl/:jobId — poll job status and results
router.get('/crawl/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status === 'running') {
    return res.json({ id: job.id, status: job.status, startedAt: job.startedAt, url: job.url });
  }

  res.json(job);
});

// GET /results — list all pages in the knowledge base, or fetch one by URL
// Query: ?url=<encoded-url>  ?limit=100  ?offset=0
router.get('/results', (req, res) => {
  const { url, limit, offset } = req.query;

  if (url) {
    const page = getPageByUrl(url);
    if (!page) return res.status(404).json({ error: 'No record found for this URL' });
    return res.json(page);
  }

  const pages = listPages({
    limit: limit ? parseInt(limit, 10) : 100,
    offset: offset ? parseInt(offset, 10) : 0,
  });
  const total = getPageCount();
  res.json({ total, count: pages.length, pages });
});

// GET /diff — compare current snapshot to previous for a URL
// Query: ?url=<encoded-url>
router.get('/diff', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query parameter is required' });

  const diff = await getDiff(url);
  if (!diff) return res.status(404).json({ error: 'No snapshot history found for this URL' });

  res.json(diff);
});

// GET /status — knowledge base stats and last run summary
router.get('/status', (req, res) => {
  const totalPages = getPageCount();
  const lastRun = getLastCrawlRun();

  res.json({
    totalPages,
    lastRun: lastRun
      ? {
          startUrl: lastRun.start_url,
          startedAt: lastRun.started_at,
          finishedAt: lastRun.finished_at,
          pagesUpdated: lastRun.pages_updated,
          pagesSkipped: lastRun.pages_skipped,
          errorCount: lastRun.error_count,
        }
      : null,
  });
});

// GET /dashboard — browser UI
router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// GET /api/pages — search + filter endpoint used by the dashboard
router.get('/api/pages', (req, res) => {
  const { q = '', section = '', limit = '50', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  const rows  = searchPages({ q, section, limit: lim, offset: off });
  const total = countFilteredPages({ q, section });

  const pages = rows.map(row => {
    let publicationDate = null;
    let excerpt = '';
    try {
      const parsed = JSON.parse(row.content);
      publicationDate = parsed.publicationDate ?? null;
      excerpt = (parsed.bodyText || '').slice(0, 200).trim();
    } catch {}
    return { url: row.url, title: row.title, last_crawled: row.last_crawled, publicationDate, excerpt };
  });

  res.json({ total, count: pages.length, pages });
});

// DELETE /reset — wipe the SQLite knowledge base and all file snapshots
router.delete('/reset', (req, res) => {
  resetDb();

  // Clear JSON snapshot files so monitor diffs also start clean
  const dataDir = path.resolve(config.outputDir);
  if (fs.existsSync(dataDir)) {
    const removed = fs
      .readdirSync(dataDir)
      .filter(f => f.endsWith('.json'));
    for (const f of removed) fs.unlinkSync(path.join(dataDir, f));
  }

  res.json({ message: 'Knowledge base and snapshots cleared.', snapshotsRemoved: 0 });
});

module.exports = router;
