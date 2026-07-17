const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { nanoid } = require('nanoid');
const config = require('../config');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Every mainstream raster image format — screenshots, camera shots, exports.
// SVG is deliberately excluded: it can embed scripts (stored-XSS vector).
const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};
const EXT_MIME = Object.fromEntries(Object.entries(ALLOWED).map(([m, e]) => [e, m]));

// Images are stored as blobs in SQLite so they live and die with the rest of
// the marketplace data. Files on an ephemeral filesystem disappear on every
// redeploy, which left listings pointing at 404s.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploadMaxBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error('Only PNG, JPG, GIF, WEBP, BMP, or AVIF images are allowed.'));
  },
});

// One-time rescue: any images still sitting in the old on-disk upload
// directory are imported into the database at boot, so links created before
// this change keep working (and survive the next redeploy).
try {
  if (fs.existsSync(config.uploadDir)) {
    const insert = db.prepare('INSERT OR IGNORE INTO images (name, mime, data) VALUES (?, ?, ?)');
    for (const f of fs.readdirSync(config.uploadDir)) {
      const mime = EXT_MIME[path.extname(f).toLowerCase()];
      if (!mime) continue;
      insert.run(f, mime, fs.readFileSync(path.join(config.uploadDir, f)));
    }
  }
} catch (err) {
  console.error('[uploads] disk import skipped:', err.message);
}

// POST /api/uploads — accepts a single image file (field name "file"), stores
// it, and returns a relative URL the caller can use as a listing/auction image.
router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Image is too large (max ${Math.round(config.uploadMaxBytes / 1024 / 1024)} MB).`
        : err.message || 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const name = `${Date.now()}-${nanoid(10)}${ALLOWED[req.file.mimetype]}`;
    db.prepare('INSERT INTO images (name, mime, data) VALUES (?, ?, ?)').run(name, req.file.mimetype, req.file.buffer);
    res.status(201).json({ url: `/uploads/${name}` });
  });
});

// GET /uploads/:name — serve an image from the database. Names are unique and
// never reused, so far-future caching is safe.
router.serveImage = (req, res, next) => {
  const name = path.basename(req.params.name);
  const row = db.prepare('SELECT mime, data FROM images WHERE name = ?').get(name);
  if (!row) return next(); // fall through to the legacy static directory
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(row.data);
};

module.exports = router;
