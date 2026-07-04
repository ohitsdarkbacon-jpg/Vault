const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify, notifyAdmins } = require('../lib/notify');
const { maybeAutoPayout } = require('../lib/payouts');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

const MIN_WITHDRAWAL_CENTS = parseInt(process.env.MIN_WITHDRAWAL_CENTS || '500', 10); // $5
const MAX_BIO_LEN = 300;

const orderCardQuery = `
  SELECT o.*,
    bu.username AS buyer_name, su.username AS seller_name,
    COALESCE(l.title, a.title) AS item_title,
    COALESCE(l.image_url, a.image_url) AS item_image,
    r.rating AS review_rating,
    (SELECT COUNT(*) FROM messages m WHERE m.order_id = o.id) AS message_count
  FROM orders o
  JOIN users bu ON bu.id = o.buyer_id
  JOIN users su ON su.id = o.seller_id
  LEFT JOIN listings l ON l.id = o.listing_id
  LEFT JOIN auctions a ON a.id = o.auction_id
  LEFT JOIN reviews r ON r.order_id = o.id
`;

// ---------- Public seller profile ----------

router.get('/users/:username', (req, res) => {
  const user = db
    .prepare('SELECT id, username, avatar_url, bio, created_at, is_banned FROM users WHERE username = ? COLLATE NOCASE')
    .get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status = 'completed') AS completed_sales,
        (SELECT COUNT(*) FROM reviews WHERE seller_id = ?) AS review_count,
        (SELECT ROUND(AVG(rating), 2) FROM reviews WHERE seller_id = ?) AS avg_rating`
    )
    .get(user.id, user.id, user.id);

  const listings = db
    .prepare(
      `SELECT l.*, u.username AS seller_name FROM listings l JOIN users u ON u.id = l.seller_id
       WHERE l.seller_id = ? AND l.status = 'active' ORDER BY l.created_at DESC LIMIT 24`
    )
    .all(user.id);
  const auctions = db
    .prepare(
      `SELECT a.*, u.username AS seller_name FROM auctions a JOIN users u ON u.id = a.seller_id
       WHERE a.seller_id = ? AND a.status = 'live' ORDER BY a.ends_at ASC LIMIT 24`
    )
    .all(user.id);
  const reviews = db
    .prepare(
      `SELECT r.rating, r.comment, r.created_at, u.username AS reviewer_name, u.avatar_url AS reviewer_avatar
       FROM reviews r JOIN users u ON u.id = r.reviewer_id
       WHERE r.seller_id = ? ORDER BY r.created_at DESC LIMIT 20`
    )
    .all(user.id);

  res.json({ user: { ...user, ...stats }, listings, auctions, reviews });
});

// ---------- My dashboard ----------

router.get('/my/overview', requireAuth, (req, res) => {
  const uid = req.user.id;
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM orders WHERE buyer_id = ? AND status IN ('paid','delivered')) AS purchases_open,
        (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status IN ('paid','delivered','disputed')) AS sales_open,
        (SELECT COUNT(*) FROM listings WHERE seller_id = ? AND status = 'active') AS active_listings,
        (SELECT COUNT(*) FROM auctions WHERE seller_id = ? AND status = 'live') AS live_auctions,
        (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0) AS unread_notifications,
        (SELECT ROUND(AVG(rating),2) FROM reviews WHERE seller_id = ?) AS avg_rating,
        (SELECT COUNT(*) FROM reviews WHERE seller_id = ?) AS review_count`
    )
    .get(uid, uid, uid, uid, uid, uid, uid);
  res.json({ balance_cents: req.user.site_credit_cents, ...counts });
});

router.get('/my/purchases', requireAuth, (req, res) => {
  const rows = db
    .prepare(`${orderCardQuery} WHERE o.buyer_id = ? ORDER BY o.updated_at DESC LIMIT 100`)
    .all(req.user.id);
  res.json({ orders: rows });
});

router.get('/my/sales', requireAuth, (req, res) => {
  const rows = db
    .prepare(`${orderCardQuery} WHERE o.seller_id = ? AND o.status != 'pending' ORDER BY o.updated_at DESC LIMIT 100`)
    .all(req.user.id);
  res.json({ orders: rows });
});

router.get('/my/listings', requireAuth, (req, res) => {
  const listings = db
    .prepare("SELECT * FROM listings WHERE seller_id = ? AND status != 'removed' ORDER BY created_at DESC LIMIT 100")
    .all(req.user.id);
  const auctions = db
    .prepare(
      `SELECT a.*, u.username AS current_bidder_name FROM auctions a
       LEFT JOIN users u ON u.id = a.current_bidder_id
       WHERE a.seller_id = ? AND a.status != 'cancelled' ORDER BY a.created_at DESC LIMIT 100`
    )
    .all(req.user.id);
  res.json({ listings, auctions });
});

// My active bids
router.get('/my/bids', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT a.*, u.username AS seller_name,
        (a.current_bidder_id = ?) AS winning,
        (SELECT MAX(amount_cents) FROM bids b WHERE b.auction_id = a.id AND b.bidder_id = ?) AS my_bid_cents
       FROM auctions a JOIN users u ON u.id = a.seller_id
       WHERE a.status IN ('live','ended') AND EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id AND b.bidder_id = ?)
       ORDER BY a.ends_at ASC LIMIT 100`
    )
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ auctions: rows });
});

router.post('/my/bio', requireAuth, (req, res) => {
  const bio = String(req.body?.bio || '').trim().slice(0, MAX_BIO_LEN);
  const mod = moderateField(bio, 'bio');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(mod.clean || null, req.user.id);
  res.json({ ok: true });
});

// ---------- Withdrawals ----------

router.get('/my/withdrawals', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user.id);
  res.json({ withdrawals: rows, min_cents: MIN_WITHDRAWAL_CENTS });
});

const PAYOUT_CURRENCIES = new Set(['btc', 'eth', 'usdttrc20', 'usdterc20', 'ltc', 'sol']);

router.post('/my/withdrawals', requireAuth, async (req, res) => {
  const amountCents = parseInt(req.body?.amount_cents, 10);
  const method = String(req.body?.method || '');
  const destination = String(req.body?.destination || '').trim().slice(0, 200);
  const currency = req.body?.currency ? String(req.body.currency).toLowerCase() : null;

  if (!Number.isInteger(amountCents) || amountCents < MIN_WITHDRAWAL_CENTS) {
    return res.status(400).json({ error: `Minimum withdrawal is $${(MIN_WITHDRAWAL_CENTS / 100).toFixed(2)}.` });
  }
  if (!['paypal', 'crypto'].includes(method)) {
    return res.status(400).json({ error: 'Method must be PayPal or crypto.' });
  }
  if (method === 'crypto' && !PAYOUT_CURRENCIES.has(currency)) {
    return res.status(400).json({ error: 'Pick a payout currency.' });
  }
  if (!destination) {
    return res.status(400).json({ error: method === 'paypal' ? 'Enter your PayPal email.' : 'Enter your wallet address.' });
  }
  if (req.user.site_credit_cents < amountCents) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }
  const pending = db
    .prepare("SELECT COUNT(*) c FROM withdrawals WHERE user_id = ? AND status = 'pending'")
    .get(req.user.id).c;
  if (pending >= 3) return res.status(400).json({ error: 'You already have 3 pending withdrawals.' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(amountCents, req.user.id);
    db.prepare(
      'INSERT INTO withdrawals (user_id, amount_cents, method, destination, currency) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, amountCents, method, destination, method === 'crypto' ? currency : null);
  });
  tx();

  // Crypto withdrawals may auto-pay immediately if within the risk caps.
  // We look up the freshly-created row to hand it to the payout evaluator.
  if (method === 'crypto') {
    const w = db.prepare(
      "SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1"
    ).get(req.user.id);
    const outcome = await maybeAutoPayout(w.id);
    if (outcome.auto) {
      return res.status(201).json({ ok: true, auto: true });
    }
    // Fell back to the manual queue — let admins know it's waiting.
    notifyAdmins('withdrawal', `${req.user.username} requested a $${(amountCents / 100).toFixed(2)} crypto withdrawal (manual: ${outcome.reason}).`, '#admin');
    return res.status(201).json({ ok: true, auto: false });
  }

  notifyAdmins('withdrawal', `${req.user.username} requested a $${(amountCents / 100).toFixed(2)} ${method} withdrawal.`, '#admin');
  res.status(201).json({ ok: true });
});

// ---------- Notifications ----------

router.get('/my/notifications', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30')
    .all(req.user.id);
  const unread = db
    .prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(req.user.id).c;
  res.json({ notifications: rows, unread });
});

router.post('/my/notifications/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- Favorites ----------

router.get('/my/favorites', requireAuth, (req, res) => {
  const listings = db
    .prepare(
      `SELECT l.*, u.username AS seller_name FROM favorites f
       JOIN listings l ON l.id = f.item_id JOIN users u ON u.id = l.seller_id
       WHERE f.user_id = ? AND f.kind = 'listing' ORDER BY f.created_at DESC`
    )
    .all(req.user.id);
  const auctions = db
    .prepare(
      `SELECT a.*, u.username AS seller_name FROM favorites f
       JOIN auctions a ON a.id = f.item_id JOIN users u ON u.id = a.seller_id
       WHERE f.user_id = ? AND f.kind = 'auction' ORDER BY f.created_at DESC`
    )
    .all(req.user.id);
  const keys = db.prepare('SELECT kind, item_id FROM favorites WHERE user_id = ?').all(req.user.id);
  res.json({ listings, auctions, keys });
});

router.post('/favorites/toggle', requireAuth, (req, res) => {
  const kind = String(req.body?.kind || '');
  const itemId = parseInt(req.body?.item_id, 10);
  if (!['listing', 'auction'].includes(kind) || !Number.isInteger(itemId)) {
    return res.status(400).json({ error: 'Invalid favorite.' });
  }
  const table = kind === 'listing' ? 'listings' : 'auctions';
  const item = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });

  const existing = db
    .prepare('SELECT 1 AS x FROM favorites WHERE user_id = ? AND kind = ? AND item_id = ?')
    .get(req.user.id, kind, itemId);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND item_id = ?').run(req.user.id, kind, itemId);
    return res.json({ favorited: false });
  }
  db.prepare('INSERT INTO favorites (user_id, kind, item_id) VALUES (?, ?, ?)').run(req.user.id, kind, itemId);
  res.json({ favorited: true });
});

module.exports = router;
