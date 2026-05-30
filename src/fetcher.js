'use strict';

/**
 * Fetcher abstracts HTTP retrieval behind a single interface.
 * Mode is chosen at construction time:
 *   headless: false  →  Axios (fast, default)
 *   headless: true   →  Puppeteer (JS-rendered content, dates, dynamic text)
 *
 * HEAD requests always use Axios — Puppeteer has no HEAD support, and HEAD
 * is only used for cheap ETag/Last-Modified cache checks anyway.
 */

const axios = require('axios');

// Block these resource types in Puppeteer — we only need the DOM tree
const BLOCKED_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'imageset']);

class Fetcher {
  constructor(opts = {}) {
    this.headless  = Boolean(opts.headless);
    this.timeout   = opts.requestTimeout ?? 10000;
    this.userAgent = opts.userAgent ?? 'WebCrawler/1.0';
    this._browser  = null;
  }

  get mode() { return this.headless ? 'puppeteer' : 'axios'; }

  // Must be called before get() when headless: true
  async init() {
    if (!this.headless) return;

    let puppeteer;
    try {
      puppeteer = require('puppeteer');
    } catch {
      throw new Error(
        'Puppeteer is not installed.\n' +
        'Run: npm install puppeteer  (downloads Chromium ~170 MB)'
      );
    }

    this._browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    console.log('[fetcher] Puppeteer browser launched');
  }

  // ── HEAD ────────────────────────────────────────────────────────────────────
  // Always Axios — used only for ETag / Last-Modified cache checks
  async head(url) {
    try {
      const res = await axios.head(url, {
        timeout: this.timeout,
        headers: { 'User-Agent': this.userAgent },
        maxRedirects: 5,
      });
      return {
        etag:         res.headers['etag']           || null,
        lastModified: res.headers['last-modified']  || null,
        contentType:  res.headers['content-type']   || '',
      };
    } catch {
      return null; // HEAD unsupported or network error — caller will do a full GET
    }
  }

  // ── GET ─────────────────────────────────────────────────────────────────────
  async get(url) {
    return this.headless ? this._getPuppeteer(url) : this._getAxios(url);
  }

  async _getAxios(url) {
    const res = await axios.get(url, {
      timeout: this.timeout,
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

  async _getPuppeteer(url) {
    if (!this._browser) throw new Error('Fetcher not initialised — call fetcher.init() first');

    const page = await this._browser.newPage();
    try {
      await page.setUserAgent(this.userAgent);

      // Abort binary resources up front — cuts page load time significantly
      await page.setRequestInterception(true);
      page.on('request', req => {
        BLOCKED_TYPES.has(req.resourceType()) ? req.abort() : req.continue();
      });

      const response = await page.goto(url, {
        waitUntil: 'networkidle2', // waits for JS to finish fetching data
        timeout: this.timeout,
      });

      if (!response) return null;

      const status = response.status();
      if (status >= 400) {
        const err = new Error(`HTTP ${status}`);
        err.response = { status };
        throw err;
      }

      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;

      // page.content() returns the fully JS-rendered DOM
      return await page.content();
    } finally {
      await page.close(); // always release the tab
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  async close() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
      console.log('[fetcher] Puppeteer browser closed');
    }
  }
}

module.exports = { Fetcher };
