const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dataDir = path.resolve(config.outputDir);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new Database(path.join(dataDir, 'crawler.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      url           TEXT PRIMARY KEY,
      content_hash  TEXT,
      etag          TEXT,
      last_modified TEXT,
      last_crawled  TEXT NOT NULL,
      title         TEXT,
      content       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pages_last_crawled ON pages (last_crawled DESC);

    CREATE TABLE IF NOT EXISTS crawl_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      start_url     TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      pages_updated INTEGER DEFAULT 0,
      pages_skipped INTEGER DEFAULT 0,
      error_count   INTEGER DEFAULT 0
    );
  `);

  return _db;
}

// Prepared statements are cached on the db instance after first use
function stmt(sql) {
  const db = getDb();
  if (!db._stmts) db._stmts = {};
  if (!db._stmts[sql]) db._stmts[sql] = db.prepare(sql);
  return db._stmts[sql];
}

function getPage(url) {
  return stmt('SELECT * FROM pages WHERE url = ?').get(url);
}

function upsertPage({ url, content_hash, etag, last_modified, last_crawled, title, content }) {
  stmt(`
    INSERT INTO pages (url, content_hash, etag, last_modified, last_crawled, title, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      content_hash  = excluded.content_hash,
      etag          = excluded.etag,
      last_modified = excluded.last_modified,
      last_crawled  = excluded.last_crawled,
      title         = excluded.title,
      content       = excluded.content
  `).run(url, content_hash, etag, last_modified, last_crawled, title, content);
}

function getPageByUrl(url) {
  const row = getPage(url);
  if (!row || !row.content) return null;
  try {
    return JSON.parse(row.content);
  } catch {
    return null;
  }
}

function listPages({ limit = 100, offset = 0 } = {}) {
  return stmt(`
    SELECT url, title, last_crawled, content_hash
    FROM pages
    ORDER BY last_crawled DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getPageCount() {
  return stmt('SELECT COUNT(*) AS count FROM pages').get().count;
}

function recordCrawlRun({ start_url, started_at, finished_at, pages_updated, pages_skipped, error_count }) {
  stmt(`
    INSERT INTO crawl_runs (start_url, started_at, finished_at, pages_updated, pages_skipped, error_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(start_url, started_at, finished_at, pages_updated, pages_skipped, error_count);
}

function getLastCrawlRun() {
  return stmt('SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1').get();
}

function _buildFilter(q, section) {
  const where = [];
  const params = [];

  if (q) {
    where.push('(title LIKE ? OR content LIKE ?)');
    const pat = `%${q}%`;
    params.push(pat, pat);
  }

  if (section) {
    const sectionMap = {
      news:           '%/news/%',
      campaigns:      '%/campaign%',
      'voter-guides': '%/voter-guide%',
      cavoterid:      '%cavoterid%',
    };
    const pat = sectionMap[section];
    if (pat) { where.push('url LIKE ?'); params.push(pat); }
  }

  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function searchPages({ q = '', section = '', limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const { whereClause, params } = _buildFilter(q, section);
  return db.prepare(`
    SELECT url, title, last_crawled, content
    FROM   pages
    ${whereClause}
    ORDER  BY last_crawled DESC
    LIMIT  ? OFFSET ?
  `).all(...params, limit, offset);
}

function countFilteredPages({ q = '', section = '' } = {}) {
  const db = getDb();
  const { whereClause, params } = _buildFilter(q, section);
  return db.prepare(`SELECT COUNT(*) AS count FROM pages ${whereClause}`).get(...params).count;
}

function resetDb() {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM pages').run();
    db.prepare('DELETE FROM crawl_runs').run();
    // Reset autoincrement counter
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'crawl_runs'").run();
  })();
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  getPage,
  upsertPage,
  getPageByUrl,
  listPages,
  getPageCount,
  searchPages,
  countFilteredPages,
  recordCrawlRun,
  getLastCrawlRun,
  resetDb,
  closeDb,
};
