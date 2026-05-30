module.exports = {
  startUrl: 'https://example.com',
  maxDepth: 2,
  rateLimitMs: 1000,
  outputDir: './data',
  requestTimeout: 10000,
  userAgent: 'WebCrawler/1.0 (github.com/your-username/web-crawler)',
  port: 3000,
  // Set true to use Puppeteer (headless Chromium) instead of Axios.
  // Captures JS-rendered content, dynamic dates, and lazy-loaded text.
  // Slower than Axios — Chromium launches once per crawl and each page
  // waits for networkidle2 before extraction.
  headless: false,
  urlFilters: {
    // Empty = restrict to same domain as startUrl. Populate to allow specific domains.
    allowedDomains: [],
    // URLs matching any of these patterns are skipped
    excludePatterns: [
      /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|ico|xml|zip|gz|tar|woff|woff2|ttf|eot|mp4|mp3|avi|mov)$/i,
    ],
  },
};
