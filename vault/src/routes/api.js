// Developer API — users mint a key and drive their account over HTTP.
//   * keysRouter  (session-authed): manage keys from the dashboard
//   * v1Router    (key-authed):     the actual command endpoints
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { moderateField } = require('../lib/moderation');
const { parseCategory } = require('../lib/search');

const MAX_TITLE_LEN = 140;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_KEYS = 5;

const hashKey = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
function isValidImageUrl(url) {
  if (!url) return false;
  if (url.startsWith('/uploads/')) return true;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

// ============================================================
// Key management (session-authed, used by the dashboard)
// ============================================================
const keysRouter = express.Router();

keysRouter.get('/keys', requireAuth, (req, res) => {
  const keys = db
    .prepare('SELECT id, label, prefix, revoked, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  res.json({ keys });
});

keysRouter.post('/keys', requireAuth, (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 40) || 'My key';
  const active = db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id = ? AND revoked = 0').get(req.user.id).n;
  if (active >= MAX_KEYS) return res.status(400).json({ error: `You can have ${MAX_KEYS} active keys — revoke one first.` });
  // vlt_live_<32 hex>. Only ever returned here; we store the hash + a prefix.
  const raw = `vlt_live_${crypto.randomBytes(16).toString('hex')}`;
  const prefix = raw.slice(0, 16);
  db.prepare('INSERT INTO api_keys (user_id, label, prefix, key_hash) VALUES (?, ?, ?, ?)').run(req.user.id, label, prefix, hashKey(raw));
  res.status(201).json({ ok: true, key: raw, prefix, label, note: 'Copy this now — it is shown only once.' });
});

keysRouter.delete('/keys/:id', requireAuth, (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!k) return res.status(404).json({ error: 'Key not found.' });
  db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(k.id);
  res.json({ ok: true });
});

// ============================================================
// Key authentication + per-key rate limit
// ============================================================
const buckets = new Map(); // key id -> { count, resetAt }
const RATE = 60; // requests per minute per key

function authenticateApiKey(req, res, next) {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(vlt_live_[a-f0-9]{32})$/i);
  if (!m) return res.status(401).json({ error: 'Missing or malformed API key. Send: Authorization: Bearer vlt_live_...' });
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(hashKey(m[1]));
  if (!row) return res.status(401).json({ error: 'Invalid or revoked API key.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.is_banned) return res.status(403).json({ error: 'Account unavailable.' });

  // Rate limit
  const now = Date.now();
  let b = buckets.get(row.id);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + 60000 }; buckets.set(row.id, b); }
  b.count += 1;
  res.set('X-RateLimit-Limit', String(RATE));
  res.set('X-RateLimit-Remaining', String(Math.max(0, RATE - b.count)));
  if (b.count > RATE) return res.status(429).json({ error: 'Rate limit exceeded — 60 requests/minute.', retry_in: Math.ceil((b.resetAt - now) / 1000) });

  // Throttled last-used stamp
  if (!row.last_used_at || now - Date.parse(row.last_used_at + 'Z') > 60000) {
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  }
  req.user = user;
  req.apiKey = row;
  next();
}

// ============================================================
// v1 command endpoints
// ============================================================
const v1Router = express.Router();

// Public, unauthenticated index — self-describing docs.
v1Router.get('/', (req, res) => {
  res.json({
    name: 'Vault API', version: '1',
    auth: 'Authorization: Bearer vlt_live_...  (mint a key in Dashboard → Developer)',
    rate_limit: '60 requests / minute / key',
    endpoints: {
      'GET /api/v1/me': 'Your account: username, balance, Pro, wallet',
      'GET /api/v1/listings': 'Your active listings',
      'POST /api/v1/listings': 'Create a listing {title, price_usd, image_url, category?, description?}',
      'PATCH /api/v1/listings/:id': 'Edit a listing {title?, price_usd?, image_url?, description?}',
      'POST /api/v1/listings/:id/close': 'Take a listing off the market',
      'GET /api/v1/orders': 'Your recent orders (as buyer or seller)',
      'GET /api/v1/notifications': 'Your latest notifications',
    },
    note: 'Money is USD. Read-only public data lives at the top-level /api/* routes.',
  });
});

// Everything below requires a key.
v1Router.use(authenticateApiKey);

v1Router.get('/me', (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, balance_cents: u.site_credit_cents,
    is_pro: !!(u.pro_until && Date.parse(u.pro_until) > Date.now()),
    wallet: u.wallet_address ? { address: u.wallet_address, currency: u.wallet_currency } : null,
  });
});

const listingQuery = `SELECT id, title, description, image_url, price_cents, status, category, created_at FROM listings`;

v1Router.get('/listings', (req, res) => {
  const rows = db.prepare(`${listingQuery} WHERE seller_id = ? AND status = 'active' ORDER BY id DESC LIMIT 100`).all(req.user.id);
  res.json({ listings: rows });
});

v1Router.post('/listings', (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required.' });
  if (title.length > MAX_TITLE_LEN) return res.status(400).json({ error: `title must be ${MAX_TITLE_LEN} characters or fewer.` });

  // Accept price_usd (dollars) or price_cents.
  let priceCents = b.price_cents != null ? parseInt(b.price_cents, 10) : Math.round(parseFloat(b.price_usd) * 100);
  if (!Number.isInteger(priceCents) || priceCents < 1) return res.status(400).json({ error: 'price_usd (or price_cents) must be a positive amount.' });

  const image_url = String(b.image_url || '').trim();
  if (!isValidImageUrl(image_url)) return res.status(400).json({ error: 'image_url is required and must be an http(s) or /uploads/ link.' });

  const description = b.description != null ? String(b.description) : null;
  if (description && description.length > MAX_DESCRIPTION_LEN) return res.status(400).json({ error: `description must be ${MAX_DESCRIPTION_LEN} characters or fewer.` });

  const modTitle = moderateField(title, 'title');
  if (!modTitle.ok) return res.status(400).json({ error: modTitle.error });
  const modDesc = moderateField(description ? description.trim() : null, 'description');
  if (!modDesc.ok) return res.status(400).json({ error: modDesc.error });

  const info = db
    .prepare("INSERT INTO listings (seller_id, title, description, image_url, price_cents, category) VALUES (?, ?, ?, ?, ?, ?)")
    .run(req.user.id, modTitle.clean, modDesc.clean || null, image_url, priceCents, parseCategory(b.category) || 'other');
  const listing = db.prepare(`${listingQuery} WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, listing });
});

v1Router.patch('/listings/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!l || l.seller_id !== req.user.id) return res.status(404).json({ error: 'Listing not found.' });
  if (l.status !== 'active') return res.status(400).json({ error: 'Only active listings can be edited.' });
  const b = req.body || {};
  const sets = [], params = [];
  if (b.title != null) {
    const t = String(b.title).trim();
    if (!t || t.length > MAX_TITLE_LEN) return res.status(400).json({ error: 'Invalid title.' });
    const mod = moderateField(t, 'title'); if (!mod.ok) return res.status(400).json({ error: mod.error });
    sets.push('title = ?'); params.push(mod.clean);
  }
  if (b.description != null) {
    const d = String(b.description).trim();
    if (d.length > MAX_DESCRIPTION_LEN) return res.status(400).json({ error: 'Description too long.' });
    const mod = moderateField(d || null, 'description'); if (!mod.ok) return res.status(400).json({ error: mod.error });
    sets.push('description = ?'); params.push(mod.clean || null);
  }
  if (b.price_usd != null || b.price_cents != null) {
    const pc = b.price_cents != null ? parseInt(b.price_cents, 10) : Math.round(parseFloat(b.price_usd) * 100);
    if (!Number.isInteger(pc) || pc < 1) return res.status(400).json({ error: 'Invalid price.' });
    sets.push('price_cents = ?'); params.push(pc);
  }
  if (b.image_url != null) {
    const img = String(b.image_url).trim();
    if (!isValidImageUrl(img)) return res.status(400).json({ error: 'Invalid image_url.' });
    sets.push('image_url = ?'); params.push(img);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  params.push(l.id);
  db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true, listing: db.prepare(`${listingQuery} WHERE id = ?`).get(l.id) });
});

v1Router.post('/listings/:id/close', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!l || l.seller_id !== req.user.id) return res.status(404).json({ error: 'Listing not found.' });
  if (l.status !== 'active') return res.status(400).json({ error: 'Listing is not active.' });
  db.prepare("UPDATE listings SET status = 'removed' WHERE id = ?").run(l.id);
  res.json({ ok: true });
});

v1Router.get('/orders', (req, res) => {
  const rows = db
    .prepare(
      `SELECT o.id, o.amount_cents, o.status, o.method, o.created_at,
        (o.buyer_id = ?) AS is_buyer, COALESCE(l.title, a.title) AS item_title
       FROM orders o
       LEFT JOIN listings l ON l.id = o.listing_id
       LEFT JOIN auctions a ON a.id = o.auction_id
       WHERE o.buyer_id = ? OR o.seller_id = ? ORDER BY o.id DESC LIMIT 50`
    )
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ orders: rows });
});

v1Router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT id, type, body, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id);
  res.json({ notifications: rows });
});

module.exports = { keysRouter, v1Router, authenticateApiKey };
