const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify, notifyAdmins } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');
const { parseCategory } = require('../lib/search');

const router = express.Router();

const MAX_ITEM_LEN = 140;
const MAX_NOTES_LEN = 500;
const ONLINE_WINDOW_MIN = 5;
const MM_RESPONSE_WINDOW_MS = 2 * 60 * 1000; // middleman must accept within 2 minutes
function money(cents) { return `$${(cents / 100).toFixed(2)}`; }

const tradeQuery = `
  SELECT t.*, u.username, u.avatar_url, u.is_verified, u.last_seen_at
  FROM trade_posts t JOIN users u ON u.id = t.user_id
`;

function isOnline(lastSeenAt) {
  if (!lastSeenAt) return 0;
  return Date.now() - Date.parse(lastSeenAt + 'Z') < ONLINE_WINDOW_MIN * 60000 ? 1 : 0;
}

// ============ Trade posts ============

router.get('/trades', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const category = parseCategory(req.query.category);
  const conditions = ["t.status = 'open'"];
  const params = [];
  if (category) { conditions.push('t.category = ?'); params.push(category); }
  if (q) {
    conditions.push("(t.offering LIKE ? ESCAPE '\\' OR t.wants LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    params.push(like, like);
  }
  const rows = db
    .prepare(`${tradeQuery} WHERE ${conditions.join(' AND ')} ORDER BY t.created_at DESC LIMIT 60`)
    .all(...params);
  res.json({ trades: rows.map((t) => ({ ...t, online: isOnline(t.last_seen_at), last_seen_at: undefined })) });
});

router.post('/trades', requireAuth, (req, res) => {
  const offering = String(req.body?.offering || '').trim().slice(0, MAX_ITEM_LEN);
  const wants = String(req.body?.wants || '').trim().slice(0, MAX_ITEM_LEN);
  const notes = req.body?.notes ? String(req.body.notes).trim().slice(0, MAX_NOTES_LEN) : null;
  if (!offering || !wants) return res.status(400).json({ error: 'Fill in what you have and what you want.' });

  const modOffering = moderateField(offering, 'item');
  if (!modOffering.ok) return res.status(400).json({ error: modOffering.error });
  const modWants = moderateField(wants, 'item');
  if (!modWants.ok) return res.status(400).json({ error: modWants.error });
  const modNotes = moderateField(notes, 'notes');
  if (!modNotes.ok) return res.status(400).json({ error: modNotes.error });

  const image_url = req.body?.image_url || null;
  if (image_url && !(image_url.startsWith('/uploads/') || /^https?:\/\//.test(image_url))) {
    return res.status(400).json({ error: 'Image URL must be a valid http(s) link.' });
  }

  const open = db.prepare("SELECT COUNT(*) c FROM trade_posts WHERE user_id = ? AND status = 'open'").get(req.user.id).c;
  if (open >= 10) return res.status(400).json({ error: 'You already have 10 open trade posts — close some first.' });

  const info = db
    .prepare('INSERT INTO trade_posts (user_id, offering, wants, category, image_url, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, modOffering.clean, modWants.clean, parseCategory(req.body?.category) || 'other', image_url, modNotes.clean || null);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

router.post('/trades/:id/close', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM trade_posts WHERE id = ?').get(req.params.id);
  if (!post || post.user_id !== req.user.id) return res.status(404).json({ error: 'Trade post not found.' });
  db.prepare("UPDATE trade_posts SET status = 'closed' WHERE id = ?").run(post.id);
  res.json({ ok: true });
});

// ============ Middleman applications ============

router.post('/middleman/apply', requireAuth, (req, res) => {
  const status = req.user.middleman_status;
  if (status === 'approved') return res.status(400).json({ error: "You're already an approved middleman." });
  if (status === 'pending') return res.status(400).json({ error: 'Your application is already waiting for review.' });
  db.prepare("UPDATE users SET middleman_status = 'pending' WHERE id = ?").run(req.user.id);
  notifyAdmins('admin', `${req.user.username} applied to become a middleman — review it in the admin panel.`, '#admin');
  res.json({ ok: true, status: 'pending' });
});

// ============ Middleman tickets ============

// Pick a random ONLINE approved middleman that isn't a party and hasn't been tried.
function pickMiddleman(ticket) {
  const tried = JSON.parse(ticket.tried || '[]');
  const placeholders = tried.length ? tried.map(() => '?').join(',') : "''";
  return db
    .prepare(
      `SELECT id, username FROM users
       WHERE middleman_status = 'approved' AND is_banned = 0
         AND id NOT IN (?, ?) AND id NOT IN (${placeholders})
         AND last_seen_at IS NOT NULL
         AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= ${ONLINE_WINDOW_MIN}
       ORDER BY RANDOM() LIMIT 1`
    )
    .get(ticket.requester_id, ticket.partner_id, ...tried);
}

function assignMiddleman(ticketId) {
  const ticket = db.prepare('SELECT * FROM mm_tickets WHERE id = ?').get(ticketId);
  if (!ticket || !['assigned'].includes(ticket.status)) return null;
  const mm = pickMiddleman(ticket);
  if (!mm) {
    db.prepare("UPDATE mm_tickets SET status = 'unavailable', middleman_id = NULL, updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    notify(ticket.requester_id, 'mm', 'No middleman is available right now — retry later, or trade directly in game if you both trust each other.', '#dashboard');
    return null;
  }
  const tried = JSON.parse(ticket.tried || '[]');
  tried.push(mm.id);
  db.prepare(
    "UPDATE mm_tickets SET middleman_id = ?, assigned_at = datetime('now'), tried = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(mm.id, JSON.stringify(tried), ticket.id);
  notify(mm.id, 'mm', `⚖️ You've been selected to middleman a trade (ticket #${ticket.id})${ticket.tip_cents ? ` — includes a ${money(ticket.tip_cents)} tip` : ''}. Accept within 2 minutes or it rotates to someone else.`, '#dashboard');
  return mm;
}

// Request a middleman for a trade post. The requester names the trade partner
// they matched with (usually agreed in DMs). Optional — trades can happen
// directly in game with no middleman.
router.post('/trades/:id/ticket', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM trade_posts WHERE id = ?').get(req.params.id);
  if (!post || post.status !== 'open') return res.status(404).json({ error: 'Trade post not found or closed.' });

  const partnerName = String(req.body?.partner || '').trim();
  const partner = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(partnerName);
  if (!partner) return res.status(404).json({ error: 'Trade partner not found — check the username.' });
  if (partner.id === req.user.id) return res.status(400).json({ error: "You can't trade with yourself." });
  // One of the two parties must own the post.
  if (post.user_id !== req.user.id && post.user_id !== partner.id) {
    return res.status(400).json({ error: 'Either you or your partner must own this trade post.' });
  }

  const existing = db
    .prepare("SELECT 1 FROM mm_tickets WHERE trade_post_id = ? AND status IN ('assigned','active') AND (requester_id = ? OR partner_id = ?)")
    .get(post.id, req.user.id, req.user.id);
  if (existing) return res.status(400).json({ error: 'You already have an open ticket on this trade.' });

  // Optional tip — purely informational. Nothing is held or paid by the
  // platform; it's a promise of gratitude the traders settle themselves,
  // shown to the middleman with the assignment.
  const tip = req.body?.tip_cents == null ? 0 : parseInt(req.body.tip_cents, 10);
  if (!Number.isInteger(tip) || tip < 0) {
    return res.status(400).json({ error: 'Tip must be a positive amount (or leave it empty).' });
  }

  const info = db
    .prepare('INSERT INTO mm_tickets (trade_post_id, requester_id, partner_id, tip_cents) VALUES (?, ?, ?, ?)')
    .run(post.id, req.user.id, partner.id, tip);
  const mm = assignMiddleman(info.lastInsertRowid);
  if (!mm) {
    return res.status(200).json({ ok: false, id: info.lastInsertRowid, error: 'No middlemen are online right now — retry later, or trade directly in game.' });
  }
  notify(partner.id, 'mm', `${req.user.username} opened a middleman ticket for your trade — ${mm.username} was requested.`, '#dashboard');
  res.status(201).json({ ok: true, id: info.lastInsertRowid, middleman: mm.username });
});

// My tickets: as a trade party or as the assigned middleman.
router.get('/mm/tickets', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT k.*, t.offering, t.wants,
        ru.username AS requester_name, pu.username AS partner_name, mu.username AS middleman_name
       FROM mm_tickets k
       JOIN trade_posts t ON t.id = k.trade_post_id
       JOIN users ru ON ru.id = k.requester_id
       JOIN users pu ON pu.id = k.partner_id
       LEFT JOIN users mu ON mu.id = k.middleman_id
       WHERE k.requester_id = ? OR k.partner_id = ? OR (k.middleman_id = ? AND k.status IN ('assigned','active'))
       ORDER BY k.updated_at DESC LIMIT 50`
    )
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ tickets: rows, middleman_status: req.user.middleman_status });
});

function loadTicket(req, res) {
  const t = db.prepare('SELECT * FROM mm_tickets WHERE id = ?').get(req.params.id);
  if (!t) { res.status(404).json({ error: 'Ticket not found.' }); return null; }
  return t;
}

// Middleman accepts — ticket goes active, everyone is connected.
router.post('/mm/tickets/:id/accept', requireAuth, (req, res) => {
  const t = loadTicket(req, res);
  if (!t) return;
  if (t.middleman_id !== req.user.id || t.status !== 'assigned') {
    return res.status(403).json({ error: 'This ticket is not waiting on you.' });
  }
  db.prepare("UPDATE mm_tickets SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(t.id);
  for (const uid of [t.requester_id, t.partner_id]) {
    notify(uid, 'mm', `⚖️ ${req.user.username} accepted your middleman ticket #${t.id} — open the ticket room in your dashboard to coordinate all together.`, '#dashboard');
  }
  res.json({ ok: true });
});

// Middleman declines — rotate immediately.
router.post('/mm/tickets/:id/decline', requireAuth, (req, res) => {
  const t = loadTicket(req, res);
  if (!t) return;
  if (t.middleman_id !== req.user.id || t.status !== 'assigned') {
    return res.status(403).json({ error: 'This ticket is not waiting on you.' });
  }
  const mm = assignMiddleman(t.id);
  res.json({ ok: true, reassigned: !!mm });
});

// Middleman marks the trade done.
router.post('/mm/tickets/:id/complete', requireAuth, (req, res) => {
  const t = loadTicket(req, res);
  if (!t) return;
  if (t.middleman_id !== req.user.id || t.status !== 'active') {
    return res.status(403).json({ error: 'Only the active middleman can complete a ticket.' });
  }
  db.prepare("UPDATE mm_tickets SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(t.id);
  for (const uid of [t.requester_id, t.partner_id]) {
    const tipNudge = t.tip_cents && uid === t.requester_id ? ` Don't forget the ${money(t.tip_cents)} tip you promised ${req.user.username}!` : '';
    notify(uid, 'mm', `✅ Middleman ticket #${t.id} completed — happy trading!${tipNudge}`, '#dashboard');
  }
  res.json({ ok: true });
});

// Either trade party cancels.
router.post('/mm/tickets/:id/cancel', requireAuth, (req, res) => {
  const t = loadTicket(req, res);
  if (!t) return;
  if (![t.requester_id, t.partner_id].includes(req.user.id)) return res.status(403).json({ error: 'Only a trade party can cancel.' });
  if (!['assigned', 'active', 'unavailable'].includes(t.status)) return res.status(400).json({ error: `Ticket is already ${t.status}.` });
  db.prepare("UPDATE mm_tickets SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(t.id);
  if (t.middleman_id) notify(t.middleman_id, 'mm', `Ticket #${t.id} was cancelled by the traders.`, '#dashboard');
  res.json({ ok: true });
});

// ============ Ticket room (shared 3-way chat) ============
// One room per ticket: both traders + the middleman coordinate in a single
// thread instead of split DMs. Admins can read it if a trade goes bad.

function canAccessTicketRoom(user, t) {
  return [t.requester_id, t.partner_id, t.middleman_id].includes(user.id) || user.is_admin;
}

router.get('/mm/tickets/:id/messages', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM mm_tickets WHERE id = ?').get(req.params.id);
  if (!t || !canAccessTicketRoom(req.user, t)) return res.status(404).json({ error: 'Ticket not found.' });
  const after = parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT m.id, m.sender_id, m.body, m.created_at, u.username AS sender_name,
        (m.sender_id = ?) AS mine, (m.sender_id = ?) AS from_mm
       FROM mm_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.ticket_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200`
    )
    .all(req.user.id, t.middleman_id || 0, t.id, after);
  res.json({
    messages,
    ticket: {
      id: t.id, status: t.status,
      requester_name: db.prepare('SELECT username FROM users WHERE id = ?').get(t.requester_id)?.username,
      partner_name: db.prepare('SELECT username FROM users WHERE id = ?').get(t.partner_id)?.username,
      middleman_name: t.middleman_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(t.middleman_id)?.username : null,
    },
  });
});

router.post('/mm/tickets/:id/messages', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM mm_tickets WHERE id = ?').get(req.params.id);
  if (!t || !canAccessTicketRoom(req.user, t)) return res.status(404).json({ error: 'Ticket not found.' });
  if (!['assigned', 'active'].includes(t.status)) {
    return res.status(400).json({ error: `This ticket is ${t.status} — the room is read-only now.` });
  }
  const body = String(req.body?.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const info = db
    .prepare('INSERT INTO mm_messages (ticket_id, sender_id, body) VALUES (?, ?, ?)')
    .run(t.id, req.user.id, mod.clean);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ============ 2-minute rotation job ============
// Assigned tickets whose middleman hasn't responded rotate to the next
// random online middleman; when no candidates remain the ticket goes
// 'unavailable' and the requester is told.
function rotateStaleTickets() {
  const stale = db
    .prepare(
      `SELECT id FROM mm_tickets WHERE status = 'assigned'
       AND (julianday('now') - julianday(assigned_at)) * 86400000 >= ?`
    )
    .all(MM_RESPONSE_WINDOW_MS);
  for (const t of stale) {
    const prev = db.prepare('SELECT middleman_id FROM mm_tickets WHERE id = ?').get(t.id);
    if (prev.middleman_id) notify(prev.middleman_id, 'mm', `Ticket #${t.id} rotated away — you didn't respond within 2 minutes.`, '#dashboard');
    assignMiddleman(t.id);
  }
  if (stale.length) console.log(`[mmTickets] rotated ${stale.length} stale ticket(s)`);
}

function startTicketRotator(intervalMs = 15000) {
  return setInterval(rotateStaleTickets, intervalMs);
}

module.exports = { router, startTicketRotator, rotateStaleTickets };
