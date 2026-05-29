const axios = require('axios');
const crypto = require('crypto');
const { URL } = require('url');
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
    this.maxDepth = opts.maxDepth ?? config.maxDepth;
    this.rateLimitMs = opts.rateLimitMs ?? config.rateLimitMs;
    this.urlFilters = opts.urlFilters ?? config.urlFilters;
    this.requestTimeout = opts.requestTimeout ?? config.requestTimeout;
    this.userAgent = opts.userAgent ?? config.userAgent;
  }

  // Cheap HEAD request to check freshness headers before committing to a full GET
  async _head(url) {
    try {
      const res = await axios.head(url, {
        timeout: this.requestTimeout,
        headers: { 'User-Agent': this.userAgent },
        maxRedirects: 5,
      });
      return {
        etag: res.headers['etag'] || null,
        lastModified: res.headers['last-modified'] || null,
        contentType: res.headers['content-type'] || '',
      };
    } catch {
      // Server doesn't support HEAD or network error — fall through to GET
      return null;
    }
  }

  async _fetch(url) {
    const res = await axios.get(url, {
      timeout: this.requestTimeout,
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      maxRedirects: 5,
      responseType: 'text',
    });
    const ct = res.headers['content-type'] || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;
    return res.data;
  }

  // Returns true only when we have a stored record AND the server's freshness
  // token definitively matches — either ETag or Last-Modified.
  _isUnchangedByHeaders(stored, head) {
    if (!stored || !head) return false;
    if (head.etag && stored.etag && head.etag === stored.etag) return true;
    if (head.lastModified && stored.last_modified && head.lastModified === stored.last_modified) return true;
    return false;
  }

  // Queue outbound links from a stored page's cached content (used when skipping a page)
  _enqueueStoredLinks(stored, startUrl, depth, visited, queue) {
    if (!stored || !stored.content) return;
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
    const visited = new Set();
    const results = [];
    const errors = [];
    let skipped = 0;
    const startedAt = new Date().toISOString();

    const normalized = normalizeUrl(startUrl);
    if (!normalized) throw new Error(`Invalid start URL: ${startUrl}`);

    const queue = [{ url: normalized, depth: 0 }];
    visited.add(normalized);

    while (queue.length > 0) {
      const { url, depth } = queue.shift();

      try {
        const head = await this._head(url);
        const stored = getPage(url);

        // Skip non-HTML early if HEAD content-type tells us so
        if (head && head.contentType &&
            !head.contentType.includes('text/html') &&
            !head.contentType.includes('application/xhtml')) {
          continue;
        }

        // --- ETag / Last-Modified cache hit ---
        if (this._isUnchangedByHeaders(stored, head)) {
          skipped++;
          console.log(`[skip:headers] ${url}`);
          if (depth < this.maxDepth) this._enqueueStoredLinks(stored, startUrl, depth, visited, queue);
          if (queue.length > 0) await sleep(this.rateLimitMs);
          continue;
        }

        // --- Full GET ---
        const html = await this._fetch(url);
        if (html === null) {
          console.log(`[skip:non-html] ${url}`);
          continue;
        }

        const contentHash = crypto.createHash('sha256').update(html).digest('hex');

        // --- Content-hash cache hit (headers absent or unreliable) ---
        if (stored && stored.content_hash === contentHash) {
          skipped++;
          console.log(`[skip:hash] ${url}`);
          // Refresh the cached headers and timestamp without re-scraping
          upsertPage({
            url,
            content_hash: contentHash,
            etag: head?.etag ?? stored.etag,
            last_modified: head?.lastModified ?? stored.last_modified,
            last_crawled: new Date().toISOString(),
            title: stored.title,
            content: stored.content,
          });
          if (depth < this.maxDepth) this._enqueueStoredLinks(stored, startUrl, depth, visited, queue);
          if (queue.length > 0) await sleep(this.rateLimitMs);
          continue;
        }

        // --- New or changed page — full scrape ---
        const pageData = scrape(html, url);

        await saveSnapshot(url, pageData);

        upsertPage({
          url,
          content_hash: contentHash,
          etag: head?.etag ?? null,
          last_modified: head?.lastModified ?? null,
          last_crawled: pageData.crawledAt,
          title: pageData.title,
          content: JSON.stringify(pageData),
        });

        results.push(pageData);

        if (onProgress) onProgress({ url, depth, pagesScraped: results.length, queued: queue.length });
        console.log(`[depth:${depth}] ${url} (${pageData.wordCount} words, ${pageData.links.length} links)`);

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

    const finishedAt = new Date().toISOString();

    recordCrawlRun({
      start_url: startUrl,
      started_at: startedAt,
      finished_at: finishedAt,
      pages_updated: results.length,
      pages_skipped: skipped,
      error_count: errors.length,
    });

    return {
      startUrl,
      finishedAt,
      pagesScraped: results.length,
      pagesSkipped: skipped,
      errorCount: errors.length,
      results,
      errors,
    };
  }
}

module.exports = { Crawler };
