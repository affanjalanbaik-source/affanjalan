'use strict';

// Preload shim that keeps the existing Express app intact while replacing only
// its public-preview static handler with catalog-gated, byte-range audio streaming.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const originalStatic = express.static;
const rootDir = path.resolve(__dirname);
const previewDir = path.resolve(process.env.PREVIEW_DIR || path.join(rootDir, 'previews'));
const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(rootDir, 'data', 'orders.sqlite'));
let metadataDb;

function getDb() {
  if (!metadataDb) {
    metadataDb = new Database(databasePath, { timeout: 5000 });
    metadataDb.pragma('busy_timeout = 5000');
    metadataDb.exec(`CREATE TABLE IF NOT EXISTS preview_metadata (
      beat_id TEXT PRIMARY KEY,
      preview_url TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      modified_at TEXT NOT NULL,
      FOREIGN KEY (beat_id) REFERENCES beats(id) ON DELETE CASCADE
    )`);
  }
  return metadataDb;
}

const mimeTypes = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac'
};

function previewStream(req, res, next) {
  let requested;
  try { requested = decodeURIComponent(req.path.slice(1)); } catch (_) { return res.sendStatus(400); }
  if (!requested || requested.includes('/') || requested.includes('\\') || path.basename(requested) !== requested) {
    return res.sendStatus(404);
  }

  const mimeType = mimeTypes[path.extname(requested).toLowerCase()];
  if (!mimeType) return res.sendStatus(404);

  let row;
  let filePath;
  let stat;
  try {
    const db = getDb();
    const previewUrl = `/previews/${requested}`;
    row = db.prepare('SELECT id FROM beats WHERE preview_url = ? AND status != ? LIMIT 1').get(previewUrl, 'archived');
    if (!row) return res.sendStatus(404);

    filePath = path.resolve(previewDir, requested);
    if (path.dirname(filePath) !== previewDir) return res.sendStatus(404);
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.sendStatus(404);
    db.prepare(`INSERT INTO preview_metadata (beat_id, preview_url, file_name, mime_type, file_size, modified_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(beat_id) DO UPDATE SET preview_url=excluded.preview_url, file_name=excluded.file_name,
      mime_type=excluded.mime_type, file_size=excluded.file_size, modified_at=excluded.modified_at`)
      .run(row.id, `/previews/${requested}`, requested, mimeType, stat.size, stat.mtime.toISOString());
  } catch (error) {
    if (error.code === 'ENOENT') return res.sendStatus(404);
    return next(error);
  }

  res.set({
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=300',
    'Content-Disposition': 'inline'
  });

  const range = req.headers.range;
  if (!range) {
    res.status(200).set('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).on('error', next).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || stat.size === 0) {
    res.set('Content-Range', `bytes */${stat.size}`);
    return res.sendStatus(416);
  }

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      res.set('Content-Range', `bytes */${stat.size}`);
      return res.sendStatus(416);
    }
    start = Math.max(0, stat.size - suffixLength);
    end = stat.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : stat.size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
    res.set('Content-Range', `bytes */${stat.size}`);
    return res.sendStatus(416);
  }
  end = Math.min(end, stat.size - 1);
  res.status(206).set({
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath, { start, end }).on('error', next).pipe(res);
}

express.static = function patchedStatic(root, options) {
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === previewDir) {
    return (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      return previewStream(req, res, next);
    };
  }
  if (resolvedRoot === rootDir) {
    const ordinaryStatic = originalStatic.call(this, root, options);
    return (req, res, next) => {
      const publicPath = decodeURI((req.path || '').split('?')[0]);
      if (publicPath === '/private-beats' || publicPath.startsWith('/private-beats/')) return res.sendStatus(404);
      if ((publicPath === '/' || publicPath === '/index.html') && req.method === 'GET') {
        return fs.readFile(path.join(rootDir, 'index.html'), 'utf8', (error, html) => {
          if (error) return next(error);
          const injected = html.replace('</body>', '<script src="/audio-preview.js" defer></script></body>');
          res.type('html').send(injected);
        });
      }
      return ordinaryStatic(req, res, next);
    };
  }
  return originalStatic.call(this, root, options);
};
