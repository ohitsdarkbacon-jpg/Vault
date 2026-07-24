// Trade-Up Events — admin-created community challenges ("start with a common
// item and trade up as far as you can before the deadline").
//
// Anti-fake model: a step only counts once the named trade partner (a real
// account) confirms it. You can only have one pending step at a time, and
// each step must trade away exactly what you currently hold, so journeys
// are a single verified line from the starting item to the final one.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

const MAX_ITEM = 120;
const MAX_STEPS = 50;
const MAX_JUMP = 20; // a single confirmed hop can't claim more than 20× value

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  next();
}
function phase(ev) {
  if (ev.status === 'cancelled') return 'cancelled';
  const now = Date.now();
  if (now < Date.parse(ev.starts_at + 'Z')) return 'upcoming';
  if (now <= Date.parse(ev.ends_at + 'Z')) return 'live';
  return 'ended';
}

// A player's current verified holding: last confirmed step, else start item.
function holding(eventId, userId) {
  const last = db
    .prepare('SELECT got, value_cents FROM trade_event_steps WHERE event_id = ? AND user_id = ? AND confirmed = 1 ORDER BY id DESC LIMIT 1')
    .get(eventId, userId);
  if (last) return { item: last.got, value_cents: last.value_cents };
  const p = db.prepare('SELECT start_item, start_value_cents FROM trade_event_players WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  return p ? { item: p.start_item, value_cents: p.start_value_cents } : null;
}

function leaderboards(eventId) {
  const players = db
    .prepare(
      `SELECT p.user_id, p.start_item, p.start_value_cents, u.username, u.avatar_url,
        (SELECT COUNT(*) FROM trade_event_steps s WHERE s.event_id = p.event_id AND s.user_id = p.user_id AND s.confirmed = 1) AS steps
       FROM trade_event_players p JOIN users u ON u.id = p.user_id WHERE p.event_id = ?`
    )
    .all(eventId)
    .map((p) => {
      const h = holding(eventId, p.user_id);
      const final = h ? h.value_cents : p.start_value_cents;
      return {
        username: p.username,
        avatar_url: p.avatar_url,
        start_item: p.start_item,
        final_item: h ? h.item : p.start_item,
        start_cents: p.start_value_cents,
        final_cents: final,
        gain_pct: p.start_value_cents ? Math.round(((final - p.start_value_cents) / p.start_value_cents) * 100) : 0,
        steps: p.steps,
      };
    });
  return {
    by_value: [...players].sort((a, b) => b.final_cents - a.final_cents).slice(0, 10),
    by_gain: [...players].sort((a, b) => b.gain_pct - a.gain_pct).slice(0, 10),
    by_steps: [...players].sort((a, b) => b.steps - a.steps).slice(0, 10),
    player_count: players.length,
  };
}

// ---------- List (public) ----------
router.get('/events', (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.*, u.username AS host,
        (SELECT COUNT(*) FROM trade_event_players p WHERE p.event_id = e.id) AS players
       FROM trade_events e JOIN users u ON u.id = e.admin_id
       WHERE e.status != 'cancelled' ORDER BY e.ends_at DESC LIMIT 30`
    )
    .all()
    .map((e) => ({ ...e, phase: phase(e), joined: req.user ? !!db.prepare('SELECT 1 FROM trade_event_players WHERE event_id = ? AND user_id = ?').get(e.id, req.user.id) : false }));
  res.json({ events: rows });
});

// ---------- Detail: journeys, leaderboards, my pending confirmations ----------
router.get('/events/:id', (req, res) => {
  const ev = db.prepare('SELECT e.*, u.username AS host FROM trade_events e JOIN users u ON u.id = e.admin_id WHERE e.id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const out = { event: { ...ev, phase: phase(ev) }, boards: leaderboards(ev.id) };
  if (req.user) {
    const me = db.prepare('SELECT * FROM trade_event_players WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id);
    if (me) {
      out.my_journey = {
        start_item: me.start_item,
        start_value_cents: me.start_value_cents,
        steps: db
          .prepare(
            `SELECT s.id, s.gave, s.got, s.value_cents, s.confirmed, s.created_at, u.username AS partner
             FROM trade_event_steps s JOIN users u ON u.id = s.partner_id
             WHERE s.event_id = ? AND s.user_id = ? ORDER BY s.id`
          )
          .all(ev.id, req.user.id),
      };
    }
    out.to_confirm = db
      .prepare(
        `SELECT s.id, s.gave, s.got, s.value_cents, u.username AS player
         FROM trade_event_steps s JOIN users u ON u.id = s.user_id
         WHERE s.event_id = ? AND s.partner_id = ? AND s.confirmed = 0`
      )
      .all(ev.id, req.user.id);
  }
  res.json(out);
});

// Public shareable journey for any player.
router.get('/events/:id/journey/:username', (req, res) => {
  const ev = db.prepare('SELECT * FROM trade_events WHERE id = ?').get(req.params.id);
  const user = db.prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)').get(req.params.username);
  if (!ev || !user) return res.status(404).json({ error: 'Not found.' });
  const p = db.prepare('SELECT * FROM trade_event_players WHERE event_id = ? AND user_id = ?').get(ev.id, user.id);
  if (!p) return res.status(404).json({ error: 'That trader is not in this event.' });
  res.json({
    username: user.username,
    start_item: p.start_item,
    start_value_cents: p.start_value_cents,
    steps: db
      .prepare('SELECT gave, got, value_cents, created_at FROM trade_event_steps WHERE event_id = ? AND user_id = ? AND confirmed = 1 ORDER BY id')
      .all(ev.id, user.id),
  });
});

// ---------- Admin: create / cancel ----------
router.post('/admin/events', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const modT = moderateField(title, 'title');
  if (!modT.ok) return res.status(400).json({ error: modT.error });
  const description = b.description ? String(b.description).trim().slice(0, 1000) : null;
  const rules = b.rules ? String(b.rules).trim().slice(0, 500) : null;
  const startsIn = Math.max(0, parseInt(b.starts_in_hours, 10) || 0);       // 0 = starts now
  const duration = parseInt(b.duration_hours, 10);
  if (!Number.isInteger(duration) || duration < 1 || duration > 168) {
    return res.status(400).json({ error: 'Duration must be 1–168 hours.' });
  }
  const cap = b.start_value_max_usd != null && b.start_value_max_usd !== ''
    ? Math.round(parseFloat(b.start_value_max_usd) * 100)
    : null;
  if (cap != null && (!Number.isFinite(cap) || cap < 1)) return res.status(400).json({ error: 'Starting value cap must be a positive amount.' });

  const info = db
    .prepare(
      `INSERT INTO trade_events (admin_id, title, description, rules, start_value_max_cents, starts_at, ends_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'), datetime('now', '+' || ? || ' hours'))`
    )
    .run(req.user.id, modT.clean, description, rules, cap, startsIn, startsIn + duration);
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'event_created', modT.clean); } catch (_) {}
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.post('/admin/events/:id/cancel', requireAuth, requireAdmin, (req, res) => {
  const ev = db.prepare('SELECT * FROM trade_events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  db.prepare("UPDATE trade_events SET status = 'cancelled' WHERE id = ?").run(ev.id);
  res.json({ ok: true });
});

// ---------- Join ----------
router.post('/events/:id/join', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM trade_events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const ph = phase(ev);
  if (ph !== 'live' && ph !== 'upcoming') return res.status(400).json({ error: 'This event is over.' });
  const item = String(req.body?.start_item || '').trim().slice(0, MAX_ITEM);
  if (!item) return res.status(400).json({ error: 'Tell us your starting item.' });
  const mod = moderateField(item, 'item');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const value = Math.round(parseFloat(req.body?.start_value_usd) * 100);
  if (!Number.isFinite(value) || value < 1) return res.status(400).json({ error: 'Starting value must be a positive amount.' });
  if (ev.start_value_max_cents && value > ev.start_value_max_cents) {
    return res.status(400).json({ error: `Starting item must be worth $${(ev.start_value_max_cents / 100).toFixed(2)} or less for this event.` });
  }
  try {
    db.prepare('INSERT INTO trade_event_players (event_id, user_id, start_item, start_value_cents) VALUES (?, ?, ?, ?)')
      .run(ev.id, req.user.id, mod.clean, value);
  } catch (e) {
    return res.status(409).json({ error: "You're already in this event." });
  }
  res.status(201).json({ ok: true });
});

// ---------- Log a trade step (partner must confirm before it counts) ----------
router.post('/events/:id/steps', requireAuth, (req, res) => {
  const ev = db.prepare('SELECT * FROM trade_events WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (phase(ev) !== 'live') return res.status(400).json({ error: 'This event is not live.' });
  const me = db.prepare('SELECT * FROM trade_event_players WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id);
  if (!me) return res.status(400).json({ error: 'Join the event first.' });

  const pending = db.prepare('SELECT 1 FROM trade_event_steps WHERE event_id = ? AND user_id = ? AND confirmed = 0').get(ev.id, req.user.id);
  if (pending) return res.status(409).json({ error: 'Your previous step is still waiting for partner confirmation.' });
  const count = db.prepare('SELECT COUNT(*) n FROM trade_event_steps WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id).n;
  if (count >= MAX_STEPS) return res.status(400).json({ error: 'Step limit reached for this event.' });

  const partnerName = String(req.body?.partner || '').trim();
  const partner = db.prepare('SELECT id, username, is_banned FROM users WHERE LOWER(username) = LOWER(?)').get(partnerName);
  if (!partner || partner.is_banned) return res.status(400).json({ error: 'Trade partner must be a Vault user (their exact username).' });
  if (partner.id === req.user.id) return res.status(400).json({ error: "You can't confirm your own trades." });

  const got = String(req.body?.got || '').trim().slice(0, MAX_ITEM);
  if (!got) return res.status(400).json({ error: 'What did you get?' });
  const mod = moderateField(got, 'item');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const value = Math.round(parseFloat(req.body?.value_usd) * 100);
  if (!Number.isFinite(value) || value < 1) return res.status(400).json({ error: 'New value must be a positive amount.' });

  // You can only trade away the exact item the system says you hold, and a
  // single hop can't claim an absurd jump — journeys stay one verified line.
  const h = holding(ev.id, req.user.id);
  if (value > h.value_cents * MAX_JUMP) {
    return res.status(400).json({ error: `That value jump is too large for one trade (max ${MAX_JUMP}× your current $${(h.value_cents / 100).toFixed(2)}).` });
  }

  const info = db
    .prepare('INSERT INTO trade_event_steps (event_id, user_id, partner_id, gave, got, value_cents) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ev.id, req.user.id, partner.id, h.item, mod.clean, value);
  notify(partner.id, 'event_step', `🎲 ${req.user.username} says they traded "${h.item}" to you for "${mod.clean}" in "${ev.title}". Confirm it in Tournaments → Events.`, '#tournaments');
  res.status(201).json({ ok: true, id: info.lastInsertRowid, gave: h.item });
});

// ---------- Partner confirms / rejects a step ----------
router.post('/events/steps/:id/confirm', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM trade_event_steps WHERE id = ?').get(req.params.id);
  if (!s || s.partner_id !== req.user.id) return res.status(404).json({ error: 'Step not found.' });
  if (s.confirmed) return res.status(400).json({ error: 'Already confirmed.' });
  db.prepare('UPDATE trade_event_steps SET confirmed = 1 WHERE id = ?').run(s.id);
  notify(s.user_id, 'event_step_ok', `🎲 ${req.user.username} confirmed your trade — "${s.got}" now counts on the leaderboard!`, '#tournaments');
  res.json({ ok: true });
});

router.post('/events/steps/:id/reject', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM trade_event_steps WHERE id = ?').get(req.params.id);
  if (!s || s.partner_id !== req.user.id) return res.status(404).json({ error: 'Step not found.' });
  if (s.confirmed) return res.status(400).json({ error: 'Already confirmed.' });
  db.prepare('DELETE FROM trade_event_steps WHERE id = ?').run(s.id);
  notify(s.user_id, 'event_step_no', `🎲 ${req.user.username} rejected a claimed trade — it won't count.`, '#tournaments');
  res.json({ ok: true });
});

module.exports = router;
