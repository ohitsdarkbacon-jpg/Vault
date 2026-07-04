const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { releaseEscrow, getOrderItemTitle } = require('../lib/fulfillOrder');
const { notify, notifyAdmins } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

const MAX_MESSAGE_LEN = 1000;
const MAX_REVIEW_LEN = 500;
const MAX_DISPUTE_LEN = 1000;

const orderQuery = `
  SELECT o.*,
    bu.username AS buyer_name, bu.avatar_url AS buyer_avatar,
    su.username AS seller_name, su.avatar_url AS seller_avatar,
    COALESCE(l.title, a.title) AS item_title,
    COALESCE(l.image_url, a.image_url) AS item_image,
    r.rating AS review_rating
  FROM orders o
  JOIN users bu ON bu.id = o.buyer_id
  JOIN users su ON su.id = o.seller_id
  LEFT JOIN listings l ON l.id = o.listing_id
  LEFT JOIN auctions a ON a.id = o.auction_id
  LEFT JOIN reviews r ON r.order_id = o.id
`;

function loadOrderForParty(req, res) {
  const order = db.prepare(`${orderQuery} WHERE o.id = ?`).get(req.params.id);
  if (!order || (order.buyer_id !== req.user.id && order.seller_id !== req.user.id && !req.user.is_admin)) {
    res.status(404).json({ error: 'Order not found.' });
    return null;
  }
  return order;
}

// GET /api/orders/:id — buyer, seller, or admin can view
router.get('/:id', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  res.json({ order });
});

// POST /api/orders/:id/delivered — seller marks the item as handed over in Roblox
router.post('/:id/delivered', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can mark an order delivered.' });
  if (order.status !== 'paid') return res.status(400).json({ error: `Order is ${order.status}, not awaiting delivery.` });

  db.prepare(
    "UPDATE orders SET status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(order.id);

  notify(
    order.buyer_id,
    'order_delivered',
    `The seller marked "${order.item_title}" as delivered. Confirm receipt to release their payment — or open a dispute if something's wrong.`,
    `#order-${order.id}`
  );
  res.json({ ok: true });
});

// POST /api/orders/:id/confirm — buyer confirms receipt → escrow released
router.post('/:id/confirm', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can confirm receipt.' });
  if (!['paid', 'delivered'].includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status} and can't be confirmed.` });
  }
  const ok = releaseEscrow(order.id, { reason: 'buyer_confirmed' });
  if (!ok) return res.status(400).json({ error: 'Could not complete this order.' });
  res.json({ ok: true });
});

// POST /api/orders/:id/dispute — buyer flags a problem; freezes auto-release
router.post('/:id/dispute', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can open a dispute.' });
  if (!['paid', 'delivered'].includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status} and can't be disputed.` });
  }
  const reason = String(req.body?.reason || '').trim().slice(0, MAX_DISPUTE_LEN);
  if (!reason) return res.status(400).json({ error: 'Please describe the problem.' });

  db.prepare(
    "UPDATE orders SET status = 'disputed', disputed_at = datetime('now'), dispute_reason = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(reason, order.id);

  notify(order.seller_id, 'order_disputed', `The buyer opened a dispute on "${order.item_title}". Payment is frozen until it's resolved. Check the order chat.`, `#order-${order.id}`);
  notifyAdmins('order_disputed', `Dispute opened on order #${order.id} ("${order.item_title}").`, `#admin`);
  res.json({ ok: true });
});

// ---------- Per-order chat (buyer <-> seller coordinate the in-game trade) ----------

router.get('/:id/messages', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  const after = parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT m.*, u.username AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.order_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200`
    )
    .all(order.id, after);
  res.json({ messages });
});

router.post('/:id/messages', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  if (req.user.id !== order.buyer_id && req.user.id !== order.seller_id) {
    return res.status(403).json({ error: 'Only the buyer and seller can chat on this order.' });
  }
  const body = String(req.body?.body || '').trim().slice(0, MAX_MESSAGE_LEN);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });

  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });

  const info = db
    .prepare('INSERT INTO messages (order_id, sender_id, body) VALUES (?, ?, ?)')
    .run(order.id, req.user.id, mod.clean);

  const recipient = req.user.id === order.buyer_id ? order.seller_id : order.buyer_id;
  // Only notify if the recipient doesn't already have an unread new_message notif for this order
  const existing = db
    .prepare("SELECT id FROM notifications WHERE user_id = ? AND type = 'new_message' AND link = ? AND is_read = 0")
    .get(recipient, `#order-${order.id}`);
  if (!existing) {
    notify(recipient, 'new_message', `New message from ${req.user.username} about "${order.item_title}".`, `#order-${order.id}`);
  }

  const message = db
    .prepare(
      `SELECT m.*, u.username AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
    )
    .get(info.lastInsertRowid);
  res.status(201).json({ message });
});

// ---------- Review (buyer -> seller, once, on completed orders) ----------

router.post('/:id/review', requireAuth, (req, res) => {
  const order = loadOrderForParty(req, res);
  if (!order) return;
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can review this order.' });
  if (order.status !== 'completed') return res.status(400).json({ error: 'You can review once the order is completed.' });

  const rating = parseInt(req.body?.rating, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be 1–5 stars.' });
  }
  const comment = req.body?.comment ? String(req.body.comment).trim().slice(0, MAX_REVIEW_LEN) : null;

  const existing = db.prepare('SELECT id FROM reviews WHERE order_id = ?').get(order.id);
  if (existing) return res.status(400).json({ error: 'You already reviewed this order.' });

  db.prepare(
    'INSERT INTO reviews (order_id, reviewer_id, seller_id, rating, comment) VALUES (?, ?, ?, ?, ?)'
  ).run(order.id, req.user.id, order.seller_id, rating, comment);

  notify(order.seller_id, 'review', `${req.user.username} left you a ${rating}★ review on "${order.item_title}".`, `#u/${req.user.username}`);
  res.status(201).json({ ok: true });
});

module.exports = router;
