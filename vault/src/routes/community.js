const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { moderateField } = require('../lib/moderation');
const { parseCategory } = require('../lib/search');
const { isPro } = require('../lib/fees');

const router = express.Router();

// ============================================================
// Looking For — want-to-buy posts. Sellers reach out via DMs.
// ============================================================

const MAX_ITEM_LEN = 140;
const MAX_NOTES_LEN = 300;

router.get('/wanted', (req, res) => {
  const category = parseCategory(req.query.category);
  const q = String(req.query.q || '').trim().slice(0, 80);
  const conditions = ["w.status = 'open'"];
  const params = [];
  if (category) { conditions.push('w.category = ?'); params.push(category); }
  if (q) {
    conditions.push("w.item LIKE ? ESCAPE '\\'");
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
  }
  const rows = db
    .prepare(
      `SELECT w.*, u.username, u.is_verified,
        (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro
       FROM wanted_posts w JOIN users u ON u.id = w.user_id
       WHERE ${conditions.join(' AND ')} ORDER BY w.created_at DESC LIMIT 60`
    )
    .all(...params);
  res.json({ wanted: rows });
});

router.post('/wanted', requireAuth, (req, res) => {
  const item = String(req.body?.item || '').trim();
  if (!item) return res.status(400).json({ error: 'Say what you\'re looking for.' });
  if (item.length > MAX_ITEM_LEN) return res.status(400).json({ error: `Keep it under ${MAX_ITEM_LEN} characters.` });
  const notes = String(req.body?.notes || '').trim();
  if (notes.length > MAX_NOTES_LEN) return res.status(400).json({ error: `Notes must be ${MAX_NOTES_LEN} characters or fewer.` });

  let budget = null;
  if (req.body?.budget_cents != null && req.body.budget_cents !== '') {
    budget = parseInt(req.body.budget_cents, 10);
    if (!Number.isInteger(budget) || budget < 100 || budget > 1000000) {
      return res.status(400).json({ error: 'Budget must be between $1 and $10,000.' });
    }
  }

  const cap = isPro(req.user) ? 25 : 10;
  const open = db.prepare("SELECT COUNT(*) c FROM wanted_posts WHERE user_id = ? AND status = 'open'").get(req.user.id).c;
  if (open >= cap) return res.status(400).json({ error: `You already have ${cap} open requests — close some first.` });

  const modItem = moderateField(item, 'request');
  if (!modItem.ok) return res.status(400).json({ error: modItem.error });
  const modNotes = moderateField(notes || null, 'notes');
  if (!modNotes.ok) return res.status(400).json({ error: modNotes.error });

  const info = db
    .prepare('INSERT INTO wanted_posts (user_id, item, budget_cents, notes, category) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, modItem.clean, budget, modNotes.clean || null, parseCategory(req.body?.category) || 'other');
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.post('/wanted/:id/close', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM wanted_posts WHERE id = ?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Request not found.' });
  if (w.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not your request.' });
  db.prepare("UPDATE wanted_posts SET status = 'closed' WHERE id = ?").run(w.id);
  res.json({ ok: true });
});

// ============================================================
// Game pulse — which games move the most money and demand.
// ============================================================

router.get('/game-stats', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.slug, c.label,
        (SELECT COALESCE(SUM(o.amount_cents), 0) FROM orders o
          LEFT JOIN listings l ON l.id = o.listing_id
          LEFT JOIN auctions a ON a.id = o.auction_id
          WHERE o.status IN ('paid','delivered','completed')
            AND COALESCE(l.category, a.category) = c.slug
            AND julianday(o.created_at) >= julianday('now','-30 days')) AS volume_30d_cents,
        (SELECT COUNT(*) FROM listings l2 WHERE l2.category = c.slug AND l2.status = 'active') +
        (SELECT COUNT(*) FROM auctions a2 WHERE a2.category = c.slug AND a2.status = 'live') AS items_live,
        (SELECT COUNT(*) FROM wanted_posts w WHERE w.category = c.slug AND w.status = 'open') +
        (SELECT COUNT(*) FROM trade_posts t WHERE t.category = c.slug AND t.status = 'open') AS looking_count
       FROM categories c
       ORDER BY volume_30d_cents DESC, items_live DESC`
    )
    .all();
  res.json({ games: rows });
});

// ============================================================
// Section chat rooms — everyone can talk; slowmode + bot checks.
// ============================================================

const ROOMS = new Set(['marketplace', 'trading', 'tournaments']);
const SLOWMODE_MS = 5000;
const MIN_ACCOUNT_AGE_MS = 5 * 60 * 1000; // brand-new accounts wait 5 minutes
const BURST_LIMIT = 10;                   // max messages per rolling minute
const MAX_ROOM_MSG_LEN = 300;

router.get('/rooms/:room/messages', (req, res) => {
  const room = String(req.params.room);
  if (!ROOMS.has(room)) return res.status(404).json({ error: 'Room not found.' });
  const after = parseInt(req.query.after, 10) || 0;
  let rows;
  if (after) {
    rows = db
      .prepare(
        `SELECT m.id, m.body, m.created_at, u.username AS sender_name, u.is_verified,
          (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro,
          (m.sender_id = ?) AS mine
         FROM room_messages m JOIN users u ON u.id = m.sender_id
         WHERE m.room = ? AND m.id > ? ORDER BY m.id ASC LIMIT 100`
      )
      .all(req.user ? req.user.id : 0, room, after);
  } else {
    // Initial load: the most recent 50, oldest-first.
    rows = db
      .prepare(
        `SELECT * FROM (
          SELECT m.id, m.body, m.created_at, u.username AS sender_name, u.is_verified,
            (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro,
            (m.sender_id = ?) AS mine
          FROM room_messages m JOIN users u ON u.id = m.sender_id
          WHERE m.room = ? ORDER BY m.id DESC LIMIT 50
        ) ORDER BY id ASC`
      )
      .all(req.user ? req.user.id : 0, room);
  }
  res.json({ messages: rows, slowmode_seconds: SLOWMODE_MS / 1000 });
});

router.post('/rooms/:room/messages', requireAuth, (req, res) => {
  const room = String(req.params.room);
  if (!ROOMS.has(room)) return res.status(404).json({ error: 'Room not found.' });

  // Bot check 1: brand-new accounts can read but not post for a few minutes.
  const ageMs = Date.now() - Date.parse(req.user.created_at + 'Z');
  if (ageMs < MIN_ACCOUNT_AGE_MS) {
    return res.status(403).json({ error: 'Fresh accounts can chat a few minutes after signing up — welcome, by the way!' });
  }

  const body = String(req.body?.body || '').trim().slice(0, MAX_ROOM_MSG_LEN);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });

  const last = db
    .prepare('SELECT body, created_at FROM room_messages WHERE sender_id = ? AND room = ? ORDER BY id DESC LIMIT 1')
    .get(req.user.id, room);

  // Slowmode: one message per 5 seconds per room.
  if (last) {
    const sinceMs = Date.now() - Date.parse(last.created_at + 'Z');
    if (sinceMs < SLOWMODE_MS) {
      const retry = Math.ceil((SLOWMODE_MS - sinceMs) / 1000);
      return res.status(429).json({ error: `Slowmode — wait ${retry}s between messages.`, retry_in: retry });
    }
    // Bot check 2: identical message repeated within a minute.
    if (last.body === body && Date.now() - Date.parse(last.created_at + 'Z') < 60 * 1000) {
      return res.status(400).json({ error: 'You just said exactly that — no repeat spam.' });
    }
  }

  // Bot check 3: burst ceiling even when pacing the slowmode perfectly.
  const lastMinute = db
    .prepare(
      `SELECT COUNT(*) c FROM room_messages
       WHERE sender_id = ? AND (julianday('now') - julianday(created_at)) * 86400 <= 60`
    )
    .get(req.user.id).c;
  if (lastMinute >= BURST_LIMIT) {
    return res.status(429).json({ error: 'Easy there — you\'re sending too many messages. Take a minute.', retry_in: 60 });
  }

  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });

  const info = db
    .prepare('INSERT INTO room_messages (room, sender_id, body) VALUES (?, ?, ?)')
    .run(room, req.user.id, mod.clean);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, slowmode_seconds: SLOWMODE_MS / 1000 });
});

module.exports = router;
