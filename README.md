# Web Crawler

A lightweight, configurable web crawler built with Node.js. Scrapes page content, follows links up to a configured depth, and tracks page changes between crawls.

## Features

- **Scraper** — extracts title, meta description, headings (h1–h6), body text, images, and outbound links
- **Link Crawler** — BFS traversal from a seed URL with configurable max depth and domain filtering
- **Change Monitor** — saves JSON snapshots per page and diffs any two consecutive crawls (title, body text, links)
- **REST API** — async crawl jobs, result retrieval, and diff endpoint via Express

## Tech Stack

| Package | Role |
|---------|------|
| [axios](https://axios-http.com/) | HTTP requests with timeout and redirect handling |
| [cheerio](https://cheerio.js.org/) | Fast server-side HTML parsing (jQuery-like API) |
| [diff](https://github.com/kpdecker/jsdiff) | Word-level text diffing for change detection |
| [express](https://expressjs.com/) | REST API server |

## Project Structure

```
web-crawler/
├── src/
│   ├── scraper.js    # HTML → structured data extraction
│   ├── crawler.js    # BFS link crawler with rate limiting
│   ├── monitor.js    # Snapshot save/load/diff logic
│   └── api.js        # Express routes
├── data/             # JSON snapshots (gitignored, auto-created)
├── config.js         # Defaults: startUrl, maxDepth, rateLimitMs, filters
├── index.js          # Entry point — starts Express server
├── package.json
└── .gitignore
```

## Setup

**Requirements:** Node.js 18+

```bash
git clone https://github.com/your-username/web-crawler.git
cd web-crawler
npm install
```

## Configuration

Edit `config.js` to set defaults:

```js
module.exports = {
  startUrl: 'https://example.com', // seed URL
  maxDepth: 2,                     // how many link hops to follow
  rateLimitMs: 1000,               // ms to wait between requests
  outputDir: './data',             // where snapshots are saved
  requestTimeout: 10000,           // axios timeout in ms
  port: 3000,
  urlFilters: {
    allowedDomains: [],            // [] = same domain as startUrl only
    excludePatterns: [             // skip URLs matching these regexes
      /\.(pdf|jpg|png|css|js|ico)$/i,
    ],
  },
};
```

All `config.js` values can be overridden per-request via the API body.

## Usage

### Start the server

```bash
npm start
# or for auto-reload during development:
npm run dev
```

The API will be available at `http://localhost:3000`.

---

## API Reference

### `POST /crawl`

Start a new crawl. Returns immediately with a `jobId`; the crawl runs in the background.

**Request body** (all fields optional):

```json
{
  "url": "https://example.com",
  "maxDepth": 2,
  "rateLimitMs": 1000
}
```

**Response** `202 Accepted`:

```json
{
  "jobId": "job_1_1720000000000",
  "status": "running",
  "url": "https://example.com",
  "message": "Crawl started. Poll GET /crawl/job_1_... for status."
}
```

```bash
curl -X POST http://localhost:3000/crawl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxDepth": 1}'
```

---

### `GET /crawl/:jobId`

Poll job status. Returns full results (including all scraped pages) once the crawl completes.

```bash
curl http://localhost:3000/crawl/job_1_1720000000000
```

**Response while running:**

```json
{ "id": "job_1_...", "status": "running", "startedAt": "...", "url": "..." }
```

**Response when done:**

```json
{
  "id": "job_1_...",
  "status": "done",
  "result": {
    "startUrl": "https://example.com",
    "finishedAt": "2024-01-15T10:30:00.000Z",
    "pagesScraped": 12,
    "errorCount": 0,
    "results": [
      {
        "url": "https://example.com",
        "crawledAt": "...",
        "title": "Example Domain",
        "metaDescription": "...",
        "headings": [{ "level": "h1", "text": "Example Domain" }],
        "bodyText": "...",
        "wordCount": 42,
        "images": [],
        "links": [{ "href": "https://www.iana.org/domains/example", "text": "More information..." }]
      }
    ],
    "errors": []
  }
}
```

---

### `GET /results`

List all stored page snapshots.

```bash
curl http://localhost:3000/results
```

```json
{
  "count": 3,
  "snapshots": [
    { "url": "https://example.com", "title": "Example Domain", "crawledAt": "...", "wordCount": 42 }
  ]
}
```

### `GET /results?url=<url>`

Retrieve the full snapshot for a specific URL.

```bash
curl "http://localhost:3000/results?url=https%3A%2F%2Fexample.com"
```

---

### `GET /diff?url=<url>`

Compare the current snapshot to the previous one for a URL.

```bash
curl "http://localhost:3000/diff?url=https%3A%2F%2Fexample.com"
```

**Response (page has changed):**

```json
{
  "url": "https://example.com",
  "isNew": false,
  "hasChanges": true,
  "previousCrawl": "2024-01-14T09:00:00.000Z",
  "currentCrawl": "2024-01-15T10:30:00.000Z",
  "changes": [
    {
      "field": "title",
      "old": "Example Domain",
      "new": "Example Domain — Updated"
    },
    {
      "field": "bodyText",
      "wordCountChange": 15,
      "added": "new paragraph content here...",
      "removed": "old paragraph content..."
    },
    {
      "field": "links",
      "added": ["https://example.com/new-page"],
      "removed": []
    }
  ]
}
```

**Response (first crawl — no previous snapshot):**

```json
{ "url": "https://example.com", "isNew": true, "crawledAt": "...", "changes": [] }
```

---

## How Snapshots Work

Each crawled URL maps to a deterministic filename (`sha256(url).slice(0,32).json`) in the `./data` directory.

When a URL is re-crawled, the existing snapshot is archived as `{hash}_{timestamp}.json` before the new snapshot is written. `GET /diff` automatically finds the most recent archive to compare against the current snapshot.

## License

MIT
