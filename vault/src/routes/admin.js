const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { releaseEscrow, refundOrder } = require('../lib/fulfillOrder');
const { notify } = require('../lib/notify');
const config = require('../config');
const { payoutsEnabled } = require('../lib/nowpayments');
const { executePayout } = require('../lib/payouts');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  next();
}
router.use(requireAuth, requireAdmin);

// ---------- Overview stats ----------

router.get('/overview', (req, res) => {
  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM listings WHERE status = 'active') AS active_listings,
        (SELECT COUNT(*) FROM auctions WHERE status = 'live') AS live_auctions,
        (SELECT COUNT(*) FROM orders WHERE status = 'disputed') AS open_disputes,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') AS pending_withdrawals,
        (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports,
        (SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE status IN ('paid','delivered','disputed') AND escrow_released = 0) AS escrow_held_cents,
        (SELECT COALESCE(SUM(fee_cents),0) FROM orders WHERE status = 'completed') AS fees_earned_cents,
        (SELECT COUNT(*) FROM orders WHERE status = 'completed') AS completed_orders`
    )
    .get();
  res.json(stats);
});

// ---------- Disputes ----------

router.get('/disputes', (req, res) => {
  const rows = db
    .prepare(
      `SELECT o.*, bu.username AS buyer_name, su.username AS seller_name,
        COALESCE(l.title, a.title) AS item_title
       FROM orders o
       JOIN users bu ON bu.id = o.buyer_id
       JOIN users su ON su.id = o.seller_id
       LEFT JOIN listings l ON l.id = o.listing_id
       LEFT JOIN auctions a ON a.id = o.auction_id
       WHERE o.status = 'disputed' ORDER BY o.disputed_at ASC`
    )
    .all();
  res.json({ disputes: rows });
});

// action: 'refund_buyer' | 'release_seller'
router.post('/disputes/:orderId/resolve', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order || order.status !== 'disputed') return res.status(404).json({ error: 'Dispute not found.' });
  const action = String(req.body?.action || '');
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

  let ok = false;
  if (action === 'refund_buyer') ok = refundOrder(order.id, { note });
  else if (action === 'release_seller') ok = releaseEscrow(order.id, { reason: 'admin_resolved' });
  else return res.status(400).json({ error: 'Action must be refund_buyer or release_seller.' });

  if (!ok) return res.status(400).json({ error: 'Could not resolve this dispute.' });
  res.json({ ok: true });
});

// ---------- Withdrawals queue ----------

router.get('/withdrawals', (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id
       WHERE w.status IN ('pending', 'processing') ORDER BY w.created_at ASC`
    )
    .all();
  res.json({ withdrawals: rows, payouts_enabled: payoutsEnabled() });
});

// One-click automated crypto payout via NOWPayments.
// Money leaves your NOWPayments balance -> seller's wallet; the IPN webhook
// flips the withdrawal to 'paid' when the chain transfer finishes.
router.post('/withdrawals/:id/send-crypto', async (req, res) => {
  if (!payoutsEnabled()) {
    return res.status(400).json({ error: 'Automated payouts are not configured (set NOWPAYMENTS_EMAIL / NOWPAYMENTS_PASSWORD / NOWPAYMENTS_2FA_SECRET).' });
  }
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w || w.status !== 'pending') return res.status(404).json({ error: 'Withdrawal not found or already processing.' });
  if (w.method !== 'crypto' || !w.currency) return res.status(400).json({ error: 'This is not a crypto withdrawal.' });

  const result = await executePayout(w, { markedAuto: false });
  if (!result.ok) return res.status(502).json({ error: `NOWPayments payout failed: ${result.error}` });
  res.json({ ok: true, status: result.status });
});

// action: 'paid' (you sent the money externally) | 'rejected' (refunds their balance)
router.post('/withdrawals/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w || w.status !== 'pending') return res.status(404).json({ error: 'Withdrawal not found.' });
  const action = String(req.body?.action || '');
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;
  if (!['paid', 'rejected'].includes(action)) return res.status(400).json({ error: 'Action must be paid or rejected.' });

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = datetime('now') WHERE id = ?"
    ).run(action, note, w.id);
    if (action === 'rejected') {
      db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(w.amount_cents, w.user_id);
    }
  });
  tx();

  notify(
    w.user_id,
    'withdrawal',
    action === 'paid'
      ? `Your $${(w.amount_cents / 100).toFixed(2)} withdrawal was sent.${note ? ' Note: ' + note : ''}`
      : `Your $${(w.amount_cents / 100).toFixed(2)} withdrawal was rejected and refunded to your balance.${note ? ' Note: ' + note : ''}`
  );
  res.json({ ok: true });
});

// ---------- Users ----------

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  let rows;
  if (q) {
    rows = db
      .prepare(
        `SELECT id, provider_id, username, site_credit_cents, is_banned, is_admin, is_verified, created_at
         FROM users WHERE username LIKE ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(`%${q.replace(/[%_]/g, '')}%`);
  } else {
    rows = db
      .prepare(
        `SELECT id, provider_id, username, site_credit_cents, is_banned, is_admin, is_verified, created_at
         FROM users ORDER BY created_at DESC LIMIT 50`
      )
      .all();
  }
  res.json({ users: rows });
});

// Toggle the verified-trader badge.
router.post('/users/:id/verify', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const next = target.is_verified ? 0 : 1;
  db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(next, target.id);
  if (next) notify(target.id, 'admin', "You're now a ✔ Verified trader — the badge shows next to your name across Vault.");
  res.json({ ok: true, verified: !!next });
});

router.post('/users/:id/ban', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.is_admin) return res.status(400).json({ error: "You can't ban an admin." });
  db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(target.id);
  // Pull their active inventory off the market
  db.prepare("UPDATE listings SET status = 'removed' WHERE seller_id = ? AND status = 'active'").run(target.id);
  db.prepare("UPDATE auctions SET status = 'cancelled' WHERE seller_id = ? AND status = 'live' AND current_bid_cents IS NULL").run(target.id);
  res.json({ ok: true });
});

router.post('/users/:id/unban', (req, res) => {
  db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Grant or deduct site credit. amount_cents is a signed delta (positive
// to add, negative to remove). Admins can credit anyone, including
// themselves. A balance can't be pushed below zero.
const MAX_CREDIT_DELTA_CENTS = 100000000; // $1,000,000 guard rail per action
router.post('/users/:id/credit', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const amount = parseInt(req.body?.amount_cents, 10);
  if (!Number.isInteger(amount) || amount === 0) {
    return res.status(400).json({ error: 'Enter a non-zero amount in cents.' });
  }
  if (Math.abs(amount) > MAX_CREDIT_DELTA_CENTS) {
    return res.status(400).json({ error: 'That amount is too large.' });
  }
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 200) : null;

  const newBalance = target.site_credit_cents + amount;
  if (newBalance < 0) {
    return res.status(400).json({ error: `Can't deduct more than the user's balance ($${(target.site_credit_cents / 100).toFixed(2)}).` });
  }

  db.prepare('UPDATE users SET site_credit_cents = ? WHERE id = ?').run(newBalance, target.id);

  const verb = amount > 0 ? 'added to' : 'removed from';
  notify(
    target.id,
    'admin',
    `$${(Math.abs(amount) / 100).toFixed(2)} was ${verb} your balance by an admin.${note ? ' Note: ' + note : ''}`
  );
  console.log(`[admin] ${req.user.username} adjusted user ${target.id} credit by ${amount}c -> ${newBalance}c`);
  res.json({ ok: true, balance_cents: newBalance });
});

// ---------- Middleman network ----------

router.get('/middlemen', (req, res) => {
  const pending = db
    .prepare("SELECT id, username, avatar_url, created_at, last_seen_at FROM users WHERE middleman_status = 'pending' ORDER BY username")
    .all();
  const approved = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url, u.last_seen_at,
        (SELECT COUNT(*) FROM mm_tickets k WHERE k.middleman_id = u.id AND k.status = 'completed') AS completed_tickets
       FROM users u WHERE u.middleman_status = 'approved' ORDER BY u.username`
    )
    .all();
  res.json({ pending, approved });
});

// action: approve | reject (pending apps) | revoke (approved MMs)
router.post('/middlemen/:userId', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const action = String(req.body?.action || '');

  if (action === 'approve') {
    if (target.middleman_status !== 'pending') return res.status(400).json({ error: 'No pending application.' });
    db.prepare("UPDATE users SET middleman_status = 'approved' WHERE id = ?").run(target.id);
    notify(target.id, 'mm', "⚖️ You're now an approved middleman! You'll get tickets when traders request one while you're online — respond within 2 minutes.");
  } else if (action === 'reject') {
    if (target.middleman_status !== 'pending') return res.status(400).json({ error: 'No pending application.' });
    db.prepare("UPDATE users SET middleman_status = 'rejected' WHERE id = ?").run(target.id);
    notify(target.id, 'mm', 'Your middleman application was not approved this time.');
  } else if (action === 'revoke') {
    if (target.middleman_status !== 'approved') return res.status(400).json({ error: 'Not an approved middleman.' });
    db.prepare("UPDATE users SET middleman_status = 'none' WHERE id = ?").run(target.id);
    notify(target.id, 'mm', 'Your middleman status was revoked by an admin.');
  } else {
    return res.status(400).json({ error: 'Action must be approve, reject, or revoke.' });
  }
  res.json({ ok: true });
});

// ---------- User reports ----------

router.get('/reports', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, ru.username AS reporter_name, tu.username AS reported_name, tu.is_banned AS reported_banned
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       JOIN users tu ON tu.id = r.reported_id
       WHERE r.status = 'open' ORDER BY r.created_at ASC LIMIT 100`
    )
    .all();
  res.json({ reports: rows });
});

router.post('/reports/:id/resolve', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report || report.status !== 'open') return res.status(404).json({ error: 'Report not found.' });
  db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(report.id);
  res.json({ ok: true });
});

// ---------- Content moderation ----------

// Browse live content so an admin can take it down. Optional ?q= filters by
// title. Returns active listings and live auctions with their seller.
router.get('/listings', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const listings = q
    ? db.prepare(`SELECT l.id, l.title, l.price_cents, l.image_url, l.created_at, u.username AS seller_name
                  FROM listings l JOIN users u ON u.id = l.seller_id
                  WHERE l.status = 'active' AND l.title LIKE ? ORDER BY l.created_at DESC LIMIT 50`).all(like)
    : db.prepare(`SELECT l.id, l.title, l.price_cents, l.image_url, l.created_at, u.username AS seller_name
                  FROM listings l JOIN users u ON u.id = l.seller_id
                  WHERE l.status = 'active' ORDER BY l.created_at DESC LIMIT 50`).all();
  const auctions = q
    ? db.prepare(`SELECT a.id, a.title, a.current_bid_cents, a.starting_bid_cents, a.image_url, a.ends_at, u.username AS seller_name
                  FROM auctions a JOIN users u ON u.id = a.seller_id
                  WHERE a.status = 'live' AND a.title LIKE ? ORDER BY a.created_at DESC LIMIT 50`).all(like)
    : db.prepare(`SELECT a.id, a.title, a.current_bid_cents, a.starting_bid_cents, a.image_url, a.ends_at, u.username AS seller_name
                  FROM auctions a JOIN users u ON u.id = a.seller_id
                  WHERE a.status = 'live' ORDER BY a.created_at DESC LIMIT 50`).all();
  res.json({ listings, auctions });
});

router.post('/listings/:id/remove', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  db.prepare("UPDATE listings SET status = 'removed' WHERE id = ?").run(l.id);
  notify(l.seller_id, 'admin', `Your listing "${l.title}" was removed by a moderator.`);
  res.json({ ok: true });
});

router.post('/auctions/:id/remove', (req, res) => {
  const a = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Auction not found.' });
  if (['paid'].includes(a.status)) return res.status(400).json({ error: 'This auction already has a paid order.' });
  db.prepare("UPDATE auctions SET status = 'cancelled' WHERE id = ?").run(a.id);
  notify(a.seller_id, 'admin', `Your auction "${a.title}" was removed by a moderator.`);
  if (a.current_bidder_id) {
    notify(a.current_bidder_id, 'admin', `The auction "${a.title}" you bid on was removed by a moderator.`);
  }
  res.json({ ok: true });
});

module.exports = router;
