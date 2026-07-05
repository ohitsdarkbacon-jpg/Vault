const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify, notifyAdmins } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

// Sends are capped; GETs stay free because the messages view polls every 4s.
const dmSendLimiter = rateLimit({ windowMs: 10 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });

const MAX_DM_LEN = 1000;
const MAX_REPORT_LEN = 500;
const ONLINE_WINDOW_MIN = 5; // last_seen within 5 min = online

function isOnline(lastSeenAt) {
  if (!lastSeenAt) return 0;
  return Date.now() - Date.parse(lastSeenAt + 'Z') < ONLINE_WINDOW_MIN * 60000 ? 1 : 0;
}

function findUser(username) {
  return db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(String(username || ''));
}

function isBlockedEitherWay(a, b) {
  return !!db
    .prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .get(a, b, b, a);
}

// ---------- Trader directory ----------
// Public list of every trader who hasn't hidden their profile.
router.get('/traders', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 50);
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.created_at, u.last_seen_at,
        (SELECT COUNT(*) FROM orders o WHERE o.seller_id = u.id AND o.status = 'completed') AS completed_sales,
        (SELECT ROUND(AVG(r.rating), 2) FROM reviews r WHERE r.seller_id = u.id) AS avg_rating,
        (SELECT COUNT(*) FROM reviews r WHERE r.seller_id = u.id) AS review_count,
        (SELECT COUNT(*) FROM listings l WHERE l.seller_id = u.id AND l.status = 'active') +
        (SELECT COUNT(*) FROM auctions a WHERE a.seller_id = u.id AND a.status = 'live') AS items_live
       FROM users u
       WHERE u.is_banned = 0 AND u.profile_hidden = 0
         ${q ? 'AND u.username LIKE ? ESCAPE \'\\\'' : ''}
       ORDER BY completed_sales DESC, u.last_seen_at DESC
       LIMIT 60`
    )
    .all(...(q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`] : []));
  res.json({
    traders: rows.map((u) => ({ ...u, online: isOnline(u.last_seen_at) })),
  });
});

// ---------- Direct messages ----------

// Conversation list: one row per partner with the latest message + unread count.
router.get('/dm/conversations', requireAuth, (req, res) => {
  const me = req.user.id;
  const rows = db
    .prepare(
      `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at,
        u.id AS partner_id, u.username AS partner_name, u.avatar_url AS partner_avatar, u.last_seen_at,
        (SELECT COUNT(*) FROM direct_messages x
          WHERE x.sender_id = u.id AND x.recipient_id = ? AND x.is_read = 0) AS unread
       FROM direct_messages m
       JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
       WHERE m.id IN (
         SELECT MAX(id) FROM direct_messages
         WHERE sender_id = ? OR recipient_id = ?
         GROUP BY CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END
       )
       ORDER BY m.id DESC`
    )
    .all(me, me, me, me, me);
  res.json({
    conversations: rows.map((c) => ({ ...c, online: isOnline(c.last_seen_at), mine: c.sender_id === me })),
  });
});

// Lightweight unread total for the header badge.
router.get('/dm/unread', requireAuth, (req, res) => {
  const { c } = db
    .prepare('SELECT COUNT(*) c FROM direct_messages WHERE recipient_id = ? AND is_read = 0')
    .get(req.user.id);
  res.json({ unread: c });
});

// Thread with one user. Marks their messages to me as read.
router.get('/dm/with/:username', requireAuth, (req, res) => {
  const partner = findUser(req.params.username);
  if (!partner || partner.id === req.user.id) return res.status(404).json({ error: 'User not found.' });

  const after = parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT id, sender_id, body, created_at FROM direct_messages
       WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND id > ?
       ORDER BY id ASC LIMIT 200`
    )
    .all(req.user.id, partner.id, partner.id, req.user.id, after);
  db.prepare('UPDATE direct_messages SET is_read = 1 WHERE sender_id = ? AND recipient_id = ? AND is_read = 0')
    .run(partner.id, req.user.id);

  res.json({
    partner: {
      username: partner.username,
      avatar_url: partner.avatar_url,
      online: isOnline(partner.last_seen_at),
      is_banned: partner.is_banned,
      blocked_by_me: !!db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(req.user.id, partner.id),
    },
    messages,
  });
});

router.post('/dm/with/:username', dmSendLimiter, requireAuth, (req, res) => {
  const partner = findUser(req.params.username);
  if (!partner) return res.status(404).json({ error: 'User not found.' });
  if (partner.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." });
  if (partner.is_banned) return res.status(400).json({ error: 'This user is banned.' });
  if (isBlockedEitherWay(req.user.id, partner.id)) {
    return res.status(403).json({ error: "You can't message this user." });
  }

  // A hidden profile can't be cold-messaged — but an existing thread
  // (either direction) stays open, and admins can always reach out.
  if (partner.profile_hidden && !req.user.is_admin) {
    const prior = db
      .prepare(
        'SELECT 1 FROM direct_messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) LIMIT 1'
      )
      .get(req.user.id, partner.id, partner.id, req.user.id);
    if (!prior) return res.status(403).json({ error: 'This user has a private profile.' });
  }

  const body = String(req.body?.body || '').trim().slice(0, MAX_DM_LEN);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });

  // Notify only when this is the first unread from me — avoids one ping per line.
  const alreadyUnread = db
    .prepare('SELECT 1 FROM direct_messages WHERE sender_id = ? AND recipient_id = ? AND is_read = 0 LIMIT 1')
    .get(req.user.id, partner.id);

  const info = db
    .prepare('INSERT INTO direct_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)')
    .run(req.user.id, partner.id, mod.clean);
  if (!alreadyUnread) {
    notify(partner.id, 'dm', `${req.user.username} sent you a message.`, `#messages/${req.user.username}`);
  }
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ---------- Privacy ----------
router.post('/my/privacy', requireAuth, (req, res) => {
  const hidden = req.body?.hidden ? 1 : 0;
  db.prepare('UPDATE users SET profile_hidden = ? WHERE id = ?').run(hidden, req.user.id);
  res.json({ ok: true, hidden: !!hidden });
});

// ---------- Block / unblock (toggle) ----------
router.post('/users/:username/block', requireAuth, (req, res) => {
  const target = findUser(req.params.username);
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'User not found.' });
  const existing = db
    .prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(req.user.id, target.id);
  if (existing) {
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, target.id);
    return res.json({ blocked: false });
  }
  db.prepare('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, target.id);
  res.json({ blocked: true });
});

// ---------- Report a user ----------
router.post('/users/:username/report', requireAuth, (req, res) => {
  const target = findUser(req.params.username);
  if (!target || target.id === req.user.id) return res.status(404).json({ error: 'User not found.' });
  const reason = String(req.body?.reason || '').trim().slice(0, MAX_REPORT_LEN);
  if (!reason) return res.status(400).json({ error: 'Describe what happened.' });

  // One open report per reporter/target pair keeps spam down.
  const dupe = db
    .prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND reported_id = ? AND status = 'open'")
    .get(req.user.id, target.id);
  if (dupe) return res.status(400).json({ error: 'You already have an open report on this user.' });

  db.prepare('INSERT INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)')
    .run(req.user.id, target.id, reason);
  notifyAdmins('admin', `${req.user.username} reported ${target.username}: "${reason}"`, `#u/${target.username}`);
  res.status(201).json({ ok: true });
});

module.exports = router;
