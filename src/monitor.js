const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Diff = require('diff');
const config = require('../config');

function urlToKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function getDataDir() {
  const dir = path.resolve(config.outputDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function currentSnapshotPath(url) {
  return path.join(getDataDir(), `${urlToKey(url)}.json`);
}

async function saveSnapshot(url, data) {
  const dir = getDataDir();
  const current = currentSnapshotPath(url);

  // Archive the existing snapshot before overwriting
  if (fs.existsSync(current)) {
    const prev = JSON.parse(fs.readFileSync(current, 'utf8'));
    const ts = prev.crawledAt ? new Date(prev.crawledAt).getTime() : Date.now();
    fs.writeFileSync(
      path.join(dir, `${urlToKey(url)}_${ts}.json`),
      JSON.stringify(prev, null, 2)
    );
  }

  fs.writeFileSync(current, JSON.stringify(data, null, 2));
}

async function loadSnapshot(url) {
  const p = currentSnapshotPath(url);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function loadPreviousSnapshot(url) {
  const dir = getDataDir();
  const prefix = `${urlToKey(url)}_`;

  const archived = fs
    .readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .pop();

  if (!archived) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, archived), 'utf8'));
}

function computeDiff(prev, curr) {
  if (!prev) {
    return { url: curr.url, isNew: true, crawledAt: curr.crawledAt, changes: [] };
  }

  const changes = [];

  if (prev.title !== curr.title)
    changes.push({ field: 'title', old: prev.title, new: curr.title });

  if (prev.metaDescription !== curr.metaDescription)
    changes.push({ field: 'metaDescription', old: prev.metaDescription, new: curr.metaDescription });

  if (prev.bodyText !== curr.bodyText) {
    const patch = Diff.diffWords(prev.bodyText || '', curr.bodyText || '');
    changes.push({
      field: 'bodyText',
      wordCountChange: curr.wordCount - prev.wordCount,
      added: patch.filter(p => p.added).map(p => p.value).join(' ').slice(0, 500),
      removed: patch.filter(p => p.removed).map(p => p.value).join(' ').slice(0, 500),
    });
  }

  const prevUrls = new Set((prev.links || []).map(l => l.href));
  const currUrls = new Set((curr.links || []).map(l => l.href));
  const addedLinks = [...currUrls].filter(u => !prevUrls.has(u));
  const removedLinks = [...prevUrls].filter(u => !currUrls.has(u));
  if (addedLinks.length || removedLinks.length)
    changes.push({ field: 'links', added: addedLinks, removed: removedLinks });

  return {
    url: curr.url,
    isNew: false,
    hasChanges: changes.length > 0,
    previousCrawl: prev.crawledAt,
    currentCrawl: curr.crawledAt,
    changes,
  };
}

async function getDiff(url) {
  const curr = await loadSnapshot(url);
  if (!curr) return null;
  const prev = await loadPreviousSnapshot(url);
  return computeDiff(prev, curr);
}

async function listSnapshots() {
  const dir = getDataDir();
  return fs
    .readdirSync(dir)
    .filter(f => /^[a-f0-9]{32}\.json$/.test(f))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { url: data.url, crawledAt: data.crawledAt, wordCount: data.wordCount, title: data.title };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.crawledAt) - new Date(a.crawledAt));
}

module.exports = { saveSnapshot, loadSnapshot, getDiff, listSnapshots, computeDiff };
