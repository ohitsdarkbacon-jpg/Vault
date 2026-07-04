const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { nanoid } = require('nanoid');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Make sure the upload directory exists (public/uploads by default, or the
// Railway volume path when UPLOAD_DIR is set).
fs.mkdirSync(config.uploadDir, { recursive: true });

const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${nanoid(10)}${ALLOWED[file.mimetype] || ''}`),
});

const upload = multer({
  storage,
  limits: { fileSize: config.uploadMaxBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error('Only PNG, JPG, GIF, or WEBP images are allowed.'));
  },
});

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
    res.status(201).json({ url: `/uploads/${path.basename(req.file.path)}` });
  });
});

module.exports = router;
