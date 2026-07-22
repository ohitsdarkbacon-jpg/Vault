const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify, notifyAdmins } = require('../lib/notify');
const { maybeAutoPayout } = require('../lib/payouts');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

const MIN_WITHDRAWAL_CENTS = parseInt(process.env.MIN_WITHDRAWAL_CENTS || '500', 10); // $5
const MAX_BIO_LEN = 300;
const config = require('../config');

// ---------- Peer-to-peer balance transfers ----------

// Preview the split so the sender sees exactly what lands where.
router.get('/my/transfer/quote', requireAuth, (req, res) => {
  const amount = parseInt(req.query.amount_cents, 10);
  if (!Number.isInteger(amount) || amount < config.minTransferCents) {
    return res.status(400).json({ error: `Minimum transfer is $${(config.minTransferCents / 100).toFixed(2)}.` });
  }
  const fee = Math.round((amount * config.transferFeeBps) / 10000);
  res.json({ amount_cents: amount, fee_cents: fee, received_cents: amount - fee, fee_bps: config.transferFeeBps });
});

router.get('/my/transfers', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, su.username AS sender_name, ru.username AS recipient_name,
        (t.sender_id = ?) AS outgoing
       FROM transfers t
       JOIN users su ON su.id = t.sender_id
       JOIN users ru ON ru.id = t.recipient_id
       WHERE t.sender_id = ? OR t.recipient_id = ? ORDER BY t.id DESC LIMIT 50`
    )
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ transfers: rows, fee_bps: config.transferFeeBps, min_cents: config.minTransferCents });
});

router.post('/my/transfer', requireAuth, (req, res) => {
  const amount = parseInt(req.body?.amount_cents, 10);
  const username = String(req.body?.to || '').trim();
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 140) : null;

  if (!username) return res.status(400).json({ error: 'Who are you sending to?' });
  if (!Number.isInteger(amount) || amount < config.minTransferCents) {
    return res.status(400).json({ error: `Minimum transfer is $${(config.minTransferCents / 100).toFixed(2)}.` });
  }
  const recipient = db.prepare('SELECT id, username, is_banned FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!recipient) return res.status(404).json({ error: 'No trader with that username.' });
  if (recipient.id === req.user.id) return res.status(400).json({ error: "You can't send balance to yourself." });
  if (recipient.is_banned) return res.status(400).json({ error: 'That account is unavailable.' });

  // Respect blocks in either direction.
  const blocked = db
    .prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .get(req.user.id, recipient.id, recipient.id, req.user.id);
  if (blocked) return res.status(403).json({ error: "You can't send balance to this trader." });

  if (req.user.site_credit_cents < amount) return res.status(400).json({ error: 'Not enough balance.' });

  const fee = Math.round((amount * config.transferFeeBps) / 10000);
  const received = amount - fee;
  if (note) {
    const mod = moderateField(note, 'note');
    if (!mod.ok) return res.status(400).json({ error: mod.error });
  }

  let transferId;
  const tx = db.transaction(() => {
    // Re-read the sender balance inside the tx to avoid a stale-read race.
    const bal = db.prepare('SELECT site_credit_cents FROM users WHERE id = ?').get(req.user.id).site_credit_cents;
    if (bal < amount) throw new Error('INSUFFICIENT');
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(amount, req.user.id);
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(received, recipient.id);
    const info = db
      .prepare('INSERT INTO transfers (sender_id, recipient_id, amount_cents, fee_cents, received_cents, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, recipient.id, amount, fee, received, note);
    transferId = info.lastInsertRowid;
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: 'Not enough balance.' }); }

  notify(recipient.id, 'transfer', `💸 ${req.user.username} sent you ${(received / 100).toFixed(2)} USD${note ? ` — “${note}”` : ''}.`, '#dashboard');
  res.status(201).json({ ok: true, id: transferId, amount_cents: amount, fee_cents: fee, received_cents: received, recipient: recipient.username });
});

// review_rating = the CALLER's own review of the order (reviews are two-way,
// so the join must be pinned to one reviewer).
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
  LEFT JOIN reviews r ON r.order_id = o.id AND r.reviewer_id = ?
`;

// ---------- Public seller profile ----------

router.get('/users/:username', (req, res) => {
  const user = db
    .prepare(`SELECT id, username, avatar_url, bio, created_at, is_banned, is_verified, profile_hidden, last_seen_at,
      (pro_until IS NOT NULL AND julianday(pro_until) > julianday('now')) AS pro
      FROM users WHERE username = ? COLLATE NOCASE`)
    .get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Hidden profiles are only visible to their owner and admins.
  const isSelf = req.user && req.user.id === user.id;
  if (user.profile_hidden && !isSelf && !(req.user && req.user.is_admin)) {
    return res.status(403).json({ private: true, username: user.username });
  }

  const online = user.last_seen_at && Date.now() - Date.parse(user.last_seen_at + 'Z') < 5 * 60000 ? 1 : 0;
  const blocked_by_me = req.user && !isSelf
    ? !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(req.user.id, user.id)
    : false;

  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM orders WHERE seller_id = ? AND status = 'completed') AS completed_sales,
        (SELECT COUNT(*) FROM reviews WHERE subject_id = ?) AS review_count,
        (SELECT ROUND(AVG(rating), 2) FROM reviews WHERE subject_id = ?) AS avg_rating`
    )
    .get(user.id, user.id, user.id);

  // Star breakdown for the histogram (5★ → 1★)
  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  db.prepare('SELECT rating, COUNT(*) c FROM reviews WHERE subject_id = ? GROUP BY rating')
    .all(user.id)
    .forEach((row) => { histogram[row.rating] = row.c; });

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
      `SELECT r.id, r.rating, r.comment, r.reply, r.replied_at, r.created_at,
        u.username AS reviewer_name, u.avatar_url AS reviewer_avatar,
        CASE WHEN o.buyer_id = r.reviewer_id THEN 'buyer' ELSE 'seller' END AS reviewer_role
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_id
       JOIN orders o ON o.id = r.order_id
       WHERE r.subject_id = ? ORDER BY r.created_at DESC LIMIT 20`
    )
    .all(user.id);

  // Achievement badges, computed from trading history (no schema needed).
  const trade = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND status = 'completed') AS trades,
        (SELECT COALESCE(MAX(amount_cents),0) FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND status = 'completed') AS biggest`
    )
    .get(user.id, user.id, user.id, user.id);
  const ageDays = (Date.now() - Date.parse(user.created_at + 'Z')) / 86400000;
  const achievements = [];
  if (trade.trades >= 1) achievements.push({ icon: '🤝', label: 'First Trade', desc: 'Completed a trade' });
  if (stats.completed_sales >= 10) achievements.push({ icon: '💼', label: 'Power Seller', desc: '10+ completed sales' });
  if (stats.avg_rating >= 4.5 && stats.review_count >= 5) achievements.push({ icon: '🌟', label: 'Top Rated', desc: '4.5★+ across 5+ reviews' });
  if (trade.biggest >= 10000) achievements.push({ icon: '🐋', label: 'Big Fish', desc: 'Completed a $100+ trade' });
  if (ageDays >= 30) achievements.push({ icon: '🏛', label: 'Vault Veteran', desc: 'Trading for 30+ days' });

  const { last_seen_at, ...pub } = user;
  res.json({ user: { ...pub, ...stats, online, blocked_by_me }, listings, auctions, reviews, histogram, achievements });
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
        (SELECT COALESCE(SUM(seller_proceeds_cents),0) FROM orders WHERE seller_id = ? AND status = 'completed') AS total_earned_cents,
        (SELECT ROUND(AVG(rating),2) FROM reviews WHERE subject_id = ?) AS avg_rating,
        (SELECT COUNT(*) FROM reviews WHERE subject_id = ?) AS review_count`
    )
    .get(uid, uid, uid, uid, uid, uid, uid, uid);
  res.json({ balance_cents: req.user.site_credit_cents, ...counts });
});

router.get('/my/purchases', requireAuth, (req, res) => {
  const rows = db
    .prepare(`${orderCardQuery} WHERE o.buyer_id = ? ORDER BY o.updated_at DESC LIMIT 100`)
    .all(req.user.id, req.user.id);
  res.json({ orders: rows });
});

router.get('/my/sales', requireAuth, (req, res) => {
  const rows = db
    .prepare(`${orderCardQuery} WHERE o.seller_id = ? AND o.status != 'pending' ORDER BY o.updated_at DESC LIMIT 100`)
    .all(req.user.id, req.user.id);
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

// ---------- Review replies ----------
// The reviewed party may post ONE public reply under a review of them.
const MAX_REPLY_LEN = 500;

router.post('/reviews/:id/reply', requireAuth, (req, res) => {
  const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (review.subject_id !== req.user.id) return res.status(403).json({ error: 'You can only reply to reviews of you.' });
  if (review.reply) return res.status(400).json({ error: 'You already replied to this review.' });

  const reply = String(req.body?.reply || '').trim().slice(0, MAX_REPLY_LEN);
  if (!reply) return res.status(400).json({ error: 'Write a reply first.' });
  const mod = moderateField(reply, 'reply');
  if (!mod.ok) return res.status(400).json({ error: mod.error });

  db.prepare("UPDATE reviews SET reply = ?, replied_at = datetime('now') WHERE id = ?").run(mod.clean, review.id);
  notify(review.reviewer_id, 'review', `${req.user.username} replied to your review.`, `#u/${req.user.username}`);
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

// Loose per-chain shape checks — enough to catch pasted garbage and
// wrong-chain mixups before money moves. NOWPayments re-validates on send.
const ADDRESS_SHAPES = {
  eth: /^0x[a-fA-F0-9]{40}$/,
  usdterc20: /^0x[a-fA-F0-9]{40}$/,
  btc: /^(bc1[a-zA-Z0-9]{20,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,40})$/,
  ltc: /^(ltc1[a-zA-Z0-9]{20,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,40})$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  usdttrc20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};
function validWalletAddress(currency, address) {
  const re = ADDRESS_SHAPES[currency];
  return !!re && re.test(address);
}

// ---------- Connected payout wallet ----------

router.put('/my/wallet', requireAuth, (req, res) => {
  const address = String(req.body?.address || '').trim();
  const currency = String(req.body?.currency || '').toLowerCase();
  if (!PAYOUT_CURRENCIES.has(currency)) return res.status(400).json({ error: 'Pick a payout currency.' });
  if (!validWalletAddress(currency, address)) {
    return res.status(400).json({ error: `That doesn't look like a valid ${currency.toUpperCase().replace('USDTTRC20', 'USDT (TRC-20)').replace('USDTERC20', 'USDT (ERC-20)')} address.` });
  }
  db.prepare('UPDATE users SET wallet_address = ?, wallet_currency = ? WHERE id = ?').run(address, currency, req.user.id);
  res.json({ ok: true, wallet: { address, currency } });
});

router.delete('/my/wallet', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET wallet_address = NULL, wallet_currency = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.post('/my/withdrawals', requireAuth, async (req, res) => {
  const amountCents = parseInt(req.body?.amount_cents, 10);
  let method = String(req.body?.method || '');
  let destination = String(req.body?.destination || '').trim().slice(0, 200);
  let currency = req.body?.currency ? String(req.body.currency).toLowerCase() : null;

  // One-click payout to the connected wallet.
  if (req.body?.use_wallet) {
    if (!req.user.wallet_address) return res.status(400).json({ error: 'No wallet connected — connect one in your Wallet tab first.' });
    method = 'crypto';
    destination = req.user.wallet_address;
    currency = req.user.wallet_currency;
  }

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

  let withdrawalId;
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(amountCents, req.user.id);
    const info = db.prepare(
      'INSERT INTO withdrawals (user_id, amount_cents, method, destination, currency) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, amountCents, method, destination, method === 'crypto' ? currency : null);
    withdrawalId = info.lastInsertRowid;
  });
  tx();

  // Crypto withdrawals may auto-pay immediately if within the risk caps.
  if (method === 'crypto') {
    const outcome = await maybeAutoPayout(withdrawalId);
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
