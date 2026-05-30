const crypto = require('crypto');
const { URL } = require('url');
const { Fetcher } = require('./fetcher');
const { scrape } = require('./scraper');
const { saveSnapshot } = require('./monitor');
const { getPage, upsertPage, recordCrawlRun } = require('./db');
const config = require('../config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    const href = u.href;
    return href.endsWith('/') && u.pathname !== '/' ? href.slice(0, -1) : href;
  } catch {
    return null;
  }
}

function isAllowed(url, startUrl, filters) {
  try {
    const parsed = new URL(url);
    const origin = new URL(startUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const allowedDomains = filters.allowedDomains || [];
    const domainOk =
      allowedDomains.length > 0
        ? allowedDomains.includes(parsed.hostname)
        : parsed.hostname === origin.hostname;
    if (!domainOk) return false;

    const testPath = parsed.pathname + parsed.search;
    return !(filters.excludePatterns || []).some(re => re.test(testPath));
  } catch {
    return false;
  }
}

class Crawler {
  constructor(opts = {}) {
    this.maxDepth      = opts.maxDepth      ?? config.maxDepth;
    this.rateLimitMs   = opts.rateLimitMs   ?? config.rateLimitMs;
    this.urlFilters    = opts.urlFilters    ?? config.urlFilters;
    this.requestTimeout= opts.requestTimeout?? config.requestTimeout;
    this.userAgent     = opts.userAgent     ?? config.userAgent;
    this.headless      = opts.headless      ?? config.headless ?? false;
    // Skip all ETag/hash cache checks and always do a full fetch+scrape.
    // Use when switching fetch modes (e.g. Axios→Puppeteer) or forcing fresh data.
    this.forceRefresh  = opts.forceRefresh  ?? false;
  }

  _isUnchangedByHeaders(stored, head) {
    if (!stored || !head) return false;
    if (head.etag         && stored.etag          && head.etag         === stored.etag)          return true;
    if (head.lastModified && stored.last_modified && head.lastModified === stored.last_modified) return true;
    return false;
  }

  _enqueueStoredLinks(stored, startUrl, depth, visited, queue) {
    if (!stored?.content) return;
    let pageData;
    try { pageData = JSON.parse(stored.content); } catch { return; }
    for (const { href } of pageData.links || []) {
      const norm = normalizeUrl(href);
      if (norm && !visited.has(norm) && isAllowed(norm, startUrl, this.urlFilters)) {
        visited.add(norm);
        queue.push({ url: norm, depth: depth + 1 });
      }
    }
  }

  async crawl(startUrl, onProgress) {
    const fetcher = new Fetcher({
      headless:       this.headless,
      requestTimeout: this.requestTimeout,
      userAgent:      this.userAgent,
    });

    await fetcher.init(); // no-op for Axios mode; launches Chromium for Puppeteer

    const visited  = new Set();
    const results  = [];
    const errors   = [];
    let   skipped  = 0;
    const startedAt = new Date().toISOString();
    const tag = `[${fetcher.mode}]`;

    const normalized = normalizeUrl(startUrl);
    if (!normalized) throw new Error(`Invalid start URL: ${startUrl}`);

    const queue = [{ url: normalized, depth: 0 }];
    visited.add(normalized);

    try {
      while (queue.length > 0) {
        const { url, depth } = queue.shift();

        try {
          // HEAD first — cheap ETag/Last-Modified check (always Axios)
          const head   = await fetcher.head(url);
          const stored = getPage(url);

          // Skip non-HTML early if the HEAD content-type tells us so
          if (head?.contentType &&
              !head.contentType.includes('text/html') &&
              !head.contentType.includes('application/xhtml')) {
            continue;
          }

          // ── ETag / Last-Modified cache hit ───────────────────────────────
          if (!this.forceRefresh && this._isUnchangedByHeaders(stored, head)) {
            skipped++;
            console.log(`[skip:headers] ${url}`);
            if (depth < this.maxDepth) this._enqueueStoredLinks(stored, startUrl, depth, visited, queue);
            if (queue.length > 0) await sleep(this.rateLimitMs);
            continue;
          }

          // ── Full page fetch (Axios or Puppeteer) ─────────────────────────
          const html = await fetcher.get(url);
          if (html === null) {
            console.log(`[skip:non-html] ${url}`);
            continue;
          }

          const contentHash = crypto.createHash('sha256').update(html).digest('hex');

          // ── Content-hash cache hit ───────────────────────────────────────
          if (!this.forceRefresh && stored?.content_hash === contentHash) {
            skipped++;
            console.log(`[skip:hash] ${url}`);
            upsertPage({
              url,
              content_hash:  contentHash,
              etag:          head?.etag          ?? stored.etag,
              last_modified: head?.lastModified  ?? stored.last_modified,
              last_crawled:  new Date().toISOString(),
              title:         stored.title,
              content:       stored.content,
            });
            if (depth < this.maxDepth) this._enqueueStoredLinks(stored, startUrl, depth, visited, queue);
            if (queue.length > 0) await sleep(this.rateLimitMs);
            continue;
          }

          // ── New or changed page — full scrape ────────────────────────────
          const pageData = scrape(html, url);

          await saveSnapshot(url, pageData);

          upsertPage({
            url,
            content_hash:  contentHash,
            etag:          head?.etag         ?? null,
            last_modified: head?.lastModified ?? null,
            last_crawled:  pageData.crawledAt,
            title:         pageData.title,
            content:       JSON.stringify(pageData),
          });

          results.push(pageData);

          if (onProgress) onProgress({ url, depth, pagesScraped: results.length, queued: queue.length });
          console.log(`${tag} [depth:${depth}] ${url} (${pageData.wordCount} words, ${pageData.links.length} links)`);

          if (depth < this.maxDepth) {
            for (const { href } of pageData.links) {
              const norm = normalizeUrl(href);
              if (norm && !visited.has(norm) && isAllowed(norm, startUrl, this.urlFilters)) {
                visited.add(norm);
                queue.push({ url: norm, depth: depth + 1 });
              }
            }
          }
        } catch (err) {
          const message = err.response ? `HTTP ${err.response.status}` : err.message;
          errors.push({ url, depth, error: message });
          console.error(`[error] ${url}: ${message}`);
        }

        if (queue.length > 0) await sleep(this.rateLimitMs);
      }
    } finally {
      await fetcher.close(); // shuts down Chromium if Puppeteer was used
    }

    const finishedAt = new Date().toISOString();

    recordCrawlRun({
      start_url:     startUrl,
      started_at:    startedAt,
      finished_at:   finishedAt,
      pages_updated: results.length,
      pages_skipped: skipped,
      error_count:   errors.length,
    });

    return {
      startUrl,
      fetchMode: fetcher.mode,
      finishedAt,
      pagesScraped: results.length,
      pagesSkipped: skipped,
      errorCount:   errors.length,
      results,
      errors,
    };
  }
}

module.exports = { Crawler };
