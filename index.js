const express = require('express');
const config = require('./config');
const api = require('./src/api');

const app = express();
app.use(express.json());
app.use(api);

// 404 fallback
app.use((req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

// Global error handler
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || config.port;
app.listen(PORT, () => {
  console.log(`\nWeb Crawler API running on http://localhost:${PORT}\n`);
  console.log('  POST /crawl              start a crawl (body: { url, maxDepth, rateLimitMs })');
  console.log('  GET  /crawl/:jobId       check job status / results');
  console.log('  GET  /results            list all snapshots');
  console.log('  GET  /results?url=<url>  get snapshot for a specific URL');
  console.log('  GET  /diff?url=<url>     get diff between last two crawls for a URL');
  console.log('');
});
