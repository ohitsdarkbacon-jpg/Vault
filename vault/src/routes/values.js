// Value list / price guide — the community reference for what items are worth.
// Admins curate the list; anyone can browse and vote whether a value looks right.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { moderateField } = require('../lib/moderation');
const { parseCategory } = require('../lib/search');

const router = express.Router();

const DEMANDS = ['low', 'medium', 'high', 'insane'];
const TRENDS = ['up', 'down', 'stable'];
const MAX_NAME = 80;
const MAX_NOTES = 200;

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  next();
}
function validImg(url) {
  if (!url) return true;
  if (url.startsWith('/uploads/')) return true;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

const SORTS = {
  value_desc: 'v.value_cents DESC',
  value_asc: 'v.value_cents ASC',
  name: 'v.name ASC',
  newest: 'v.id DESC',
};

// ---------- Browse (public) ----------
router.get('/values', (req, res) => {
  const game = parseCategory(req.query.game);
  const q = String(req.query.q || '').trim().slice(0, 60);
  const order = SORTS[req.query.sort] || SORTS.value_desc;
  const conds = [];
  const params = [];
  if (game) { conds.push('v.game = ?'); params.push(game); }
  if (q) { conds.push("v.name LIKE ? ESCAPE '\\'"); params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const uid = req.user ? req.user.id : 0;
  const rows = db
    .prepare(
      `SELECT v.*,
        (SELECT COUNT(*) FROM value_votes x WHERE x.item_id = v.id AND x.vote = 'accurate') AS v_accurate,
        (SELECT COUNT(*) FROM value_votes x WHERE x.item_id = v.id AND x.vote = 'low') AS v_low,
        (SELECT COUNT(*) FROM value_votes x WHERE x.item_id = v.id AND x.vote = 'high') AS v_high,
        (SELECT vote FROM value_votes x WHERE x.item_id = v.id AND x.user_id = ?) AS my_vote
       FROM value_items v ${where} ORDER BY ${order} LIMIT 200`
    )
    .all(uid, ...params);
  res.json({ items: rows });
});

// ---------- Community accuracy vote ----------
router.post('/values/:id/vote', requireAuth, (req, res) => {
  const item = db.prepare('SELECT id FROM value_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const vote = String(req.body?.vote || '');
  if (!['accurate', 'low', 'high'].includes(vote)) return res.status(400).json({ error: 'Vote must be accurate, low, or high.' });
  const existing = db.prepare('SELECT vote FROM value_votes WHERE item_id = ? AND user_id = ?').get(item.id, req.user.id);
  if (existing && existing.vote === vote) {
    db.prepare('DELETE FROM value_votes WHERE item_id = ? AND user_id = ?').run(item.id, req.user.id);
    return res.json({ ok: true, my_vote: null });
  }
  db.prepare(
    `INSERT INTO value_votes (item_id, user_id, vote) VALUES (?, ?, ?)
     ON CONFLICT(item_id, user_id) DO UPDATE SET vote = excluded.vote, created_at = datetime('now')`
  ).run(item.id, req.user.id, vote);
  res.json({ ok: true, my_vote: vote });
});

// ---------- Admin CRUD ----------
function parseItemBody(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > MAX_NAME) return { error: 'Name is required (max 80 chars).' };
  // Prefer an explicit value_usd (from the form) over a spread-in value_cents.
  const value_cents = (b.value_usd != null && b.value_usd !== '')
    ? Math.round(parseFloat(b.value_usd) * 100)
    : parseInt(b.value_cents, 10);
  if (!Number.isInteger(value_cents) || value_cents < 1) return { error: 'Value must be a positive amount.' };
  const demand = DEMANDS.includes(b.demand) ? b.demand : 'medium';
  const trend = TRENDS.includes(b.trend) ? b.trend : 'stable';
  const image_url = b.image_url ? String(b.image_url).trim() : null;
  if (!validImg(image_url)) return { error: 'Image URL must be an http(s) or /uploads/ link.' };
  const notes = b.notes ? String(b.notes).trim().slice(0, MAX_NOTES) : null;
  const modName = moderateField(name, 'name');
  if (!modName.ok) return { error: modName.error };
  const modNotes = moderateField(notes, 'notes');
  if (!modNotes.ok) return { error: modNotes.error };
  return { name: modName.clean, game: parseCategory(b.game) || 'other', value_cents, demand, trend, image_url, notes: modNotes.clean || null };
}

router.post('/admin/values', requireAuth, requireAdmin, (req, res) => {
  const p = parseItemBody(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const info = db
    .prepare('INSERT INTO value_items (name, game, value_cents, demand, trend, image_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.name, p.game, p.value_cents, p.demand, p.trend, p.image_url, p.notes);
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'value_added', `${p.name} (${(p.value_cents / 100).toFixed(2)})`); } catch (_) {}
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.patch('/admin/values/:id', requireAuth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM value_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const p = parseItemBody({ ...item, value_usd: undefined, ...req.body });
  if (p.error) return res.status(400).json({ error: p.error });
  db.prepare(
    "UPDATE value_items SET name = ?, game = ?, value_cents = ?, demand = ?, trend = ?, image_url = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(p.name, p.game, p.value_cents, p.demand, p.trend, p.image_url, p.notes, item.id);
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'value_edited', p.name); } catch (_) {}
  res.json({ ok: true });
});

router.delete('/admin/values/:id', requireAuth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM value_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  db.transaction(() => {
    db.prepare('DELETE FROM value_votes WHERE item_id = ?').run(item.id);
    db.prepare('DELETE FROM value_items WHERE id = ?').run(item.id);
  })();
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'value_removed', item.name); } catch (_) {}
  res.json({ ok: true });
});

module.exports = router;
