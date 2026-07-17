const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');
const { parseCategory } = require('../lib/search');

const router = express.Router();

const MAX_TITLE_LEN = 80;
const MAX_DESC_LEN = 500;
const MAX_PRIZE_LEN = 120;
const MIN_PLAYERS = 2;
const MAX_PLAYER_LIMIT = 128;
const CLOSE_HOURS = [1, 2, 3, 6, 12, 24, 48, 72];
const MAX_HOSTED_ACTIVE = 3;
const ONLINE_WINDOW_MIN = 5;

const tournamentQuery = `
  SELECT t.*, u.username AS host_name, u.is_verified AS host_verified,
    (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS player_count,
    mm.username AS middleman_name
  FROM tournaments t
  JOIN users u ON u.id = t.host_id
  LEFT JOIN users mm ON mm.id = t.middleman_id
`;

function signupsOpen(t) {
  return t.status === 'open'
    && db.prepare("SELECT julianday(?) > julianday('now') AS open").get(t.signups_close_at).open === 1;
}

function isParticipant(tournamentId, userId) {
  return !!db.prepare('SELECT 1 FROM tournament_players WHERE tournament_id = ? AND user_id = ?').get(tournamentId, userId);
}

function canAccessChat(user, t) {
  return user.is_admin || t.middleman_id === user.id || isParticipant(t.id, user.id);
}

// ============ Browse ============

router.get('/tournaments', (req, res) => {
  const rows = db
    .prepare(
      `${tournamentQuery}
       ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'ongoing' THEN 1 ELSE 2 END,
         CASE WHEN t.status = 'open' THEN t.signups_close_at END ASC,
         t.id DESC
       LIMIT 40`
    )
    .all();
  let joined = new Set();
  if (req.user) {
    joined = new Set(
      db.prepare('SELECT tournament_id FROM tournament_players WHERE user_id = ?').all(req.user.id).map((r) => r.tournament_id)
    );
  }
  res.json({
    tournaments: rows.map((t) => ({ ...t, joined: joined.has(t.id) ? 1 : 0 })),
  });
});

// ============ Host ============

router.post('/tournaments', requireAuth, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give your tournament a title.' });
  if (title.length > MAX_TITLE_LEN) return res.status(400).json({ error: `Title must be ${MAX_TITLE_LEN} characters or fewer.` });
  const description = String(b.description || '').trim();
  if (description.length > MAX_DESC_LEN) return res.status(400).json({ error: `Description must be ${MAX_DESC_LEN} characters or fewer.` });

  const prizeMode = String(b.prize_mode || 'none');
  if (!['mm_held', 'unheld', 'none'].includes(prizeMode)) return res.status(400).json({ error: 'Invalid prize option.' });
  const prize = String(b.prize || '').trim();
  if (prizeMode !== 'none' && !prize) return res.status(400).json({ error: 'Describe the prize (or pick “No prize”).' });
  if (prize.length > MAX_PRIZE_LEN) return res.status(400).json({ error: `Prize must be ${MAX_PRIZE_LEN} characters or fewer.` });

  const playerLimit = parseInt(b.player_limit, 10);
  if (!Number.isInteger(playerLimit) || playerLimit < MIN_PLAYERS || playerLimit > MAX_PLAYER_LIMIT) {
    return res.status(400).json({ error: `Player limit must be between ${MIN_PLAYERS} and ${MAX_PLAYER_LIMIT}.` });
  }

  const closeHours = parseInt(b.close_hours, 10);
  if (!CLOSE_HOURS.includes(closeHours)) return res.status(400).json({ error: 'Pick a valid signup window.' });

  const active = db
    .prepare("SELECT COUNT(*) AS n FROM tournaments WHERE host_id = ? AND status IN ('open','ongoing')")
    .get(req.user.id).n;
  if (active >= MAX_HOSTED_ACTIVE) {
    return res.status(400).json({ error: `You can host at most ${MAX_HOSTED_ACTIVE} active tournaments — finish or cancel one first.` });
  }

  const modTitle = moderateField(title, 'title');
  if (!modTitle.ok) return res.status(400).json({ error: modTitle.error });
  const modDesc = moderateField(description || null, 'description');
  if (!modDesc.ok) return res.status(400).json({ error: modDesc.error });
  const modPrize = moderateField(prize || null, 'prize');
  if (!modPrize.ok) return res.status(400).json({ error: modPrize.error });

  const closesAt = new Date(Date.now() + closeHours * 3600 * 1000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO tournaments (host_id, title, description, category, prize, prize_mode, player_limit, signups_close_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      modTitle.clean,
      modDesc.clean || null,
      parseCategory(b.category) || 'other',
      prizeMode === 'none' ? null : modPrize.clean,
      prizeMode,
      playerLimit,
      closesAt
    );
  // The host plays too.
  db.prepare('INSERT INTO tournament_players (tournament_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.user.id);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ============ Join / leave ============

router.post('/tournaments/:id/join', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  if (!signupsOpen(t)) return res.status(400).json({ error: 'Signups for this tournament are closed.' });
  if (isParticipant(t.id, req.user.id)) return res.status(400).json({ error: "You're already signed up." });
  const count = db.prepare('SELECT COUNT(*) AS n FROM tournament_players WHERE tournament_id = ?').get(t.id).n;
  if (count >= t.player_limit) return res.status(400).json({ error: 'This tournament is full.' });
  db.prepare('INSERT INTO tournament_players (tournament_id, user_id) VALUES (?, ?)').run(t.id, req.user.id);
  notify(t.host_id, 'tournament', `${req.user.username} joined your tournament “${t.title}” (${count + 1}/${t.player_limit}).`, '#tournaments');
  res.json({ ok: true });
});

router.post('/tournaments/:id/leave', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  if (t.host_id === req.user.id) return res.status(400).json({ error: 'Hosts can\'t leave — cancel the tournament instead.' });
  if (t.status !== 'open') return res.status(400).json({ error: 'Signups are closed — you\'re in it now.' });
  const r = db.prepare('DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?').run(t.id, req.user.id);
  if (!r.changes) return res.status(400).json({ error: "You're not signed up for this tournament." });
  res.json({ ok: true });
});

// ============ Host / admin controls ============

router.post('/tournaments/:id/cancel', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  if (t.host_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the host can cancel this tournament.' });
  if (!['open', 'ongoing'].includes(t.status)) return res.status(400).json({ error: 'This tournament is already finished.' });
  db.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(t.id);
  const players = db.prepare('SELECT user_id FROM tournament_players WHERE tournament_id = ? AND user_id != ?').all(t.id, req.user.id);
  players.forEach((p) => notify(p.user_id, 'tournament', `Tournament “${t.title}” was cancelled by the ${t.host_id === req.user.id ? 'host' : 'moderators'}.`, '#tournaments'));
  res.json({ ok: true });
});

router.post('/tournaments/:id/complete', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  if (t.host_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the host can complete this tournament.' });
  if (t.status !== 'ongoing') return res.status(400).json({ error: 'Only an ongoing tournament can be completed.' });
  db.prepare("UPDATE tournaments SET status = 'completed' WHERE id = ?").run(t.id);
  const players = db.prepare('SELECT user_id FROM tournament_players WHERE tournament_id = ? AND user_id != ?').all(t.id, req.user.id);
  players.forEach((p) => notify(p.user_id, 'tournament', `Tournament “${t.title}” has wrapped up — thanks for playing! 🏆`, '#tournaments'));
  res.json({ ok: true });
});

// ============ Group chat (opens when the tournament goes ongoing) ============

router.get('/tournaments/:id/messages', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t || !canAccessChat(req.user, t)) return res.status(404).json({ error: 'Tournament not found.' });
  if (t.status === 'open') return res.status(400).json({ error: 'The group chat opens when signups close.' });
  const after = parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT m.id, m.sender_id, m.body, m.created_at, u.username AS sender_name,
        (m.sender_id = ?) AS mine, (m.sender_id = ?) AS from_host, (m.sender_id = ?) AS from_mm
       FROM tournament_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.tournament_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200`
    )
    .all(req.user.id, t.host_id, t.middleman_id || 0, t.id, after);
  res.json({
    messages,
    tournament: {
      id: t.id, title: t.title, status: t.status, prize: t.prize, prize_mode: t.prize_mode,
      host_name: db.prepare('SELECT username FROM users WHERE id = ?').get(t.host_id)?.username,
      middleman_name: t.middleman_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(t.middleman_id)?.username : null,
      player_count: db.prepare('SELECT COUNT(*) AS n FROM tournament_players WHERE tournament_id = ?').get(t.id).n,
    },
  });
});

router.post('/tournaments/:id/messages', requireAuth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t || !canAccessChat(req.user, t)) return res.status(404).json({ error: 'Tournament not found.' });
  if (t.status !== 'ongoing') {
    return res.status(400).json({ error: t.status === 'open' ? 'The group chat opens when signups close.' : 'This tournament is over — the chat is read-only now.' });
  }
  const body = String(req.body?.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const info = db
    .prepare('INSERT INTO tournament_messages (tournament_id, sender_id, body) VALUES (?, ?, ?)')
    .run(t.id, req.user.id, mod.clean);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ============ Deadline job ============
// Flips open tournaments whose signup deadline passed: enough players →
// ongoing (chat opens, everyone notified, prize middleman assigned if
// requested); too few → cancelled. Also retries middleman assignment for
// ongoing mm_held tournaments that couldn't get one yet.

function assignPrizeMiddleman(t) {
  const mm = db
    .prepare(
      `SELECT id, username FROM users
       WHERE middleman_status = 'approved' AND is_banned = 0
         AND id NOT IN (SELECT user_id FROM tournament_players WHERE tournament_id = ?)
         AND last_seen_at IS NOT NULL
         AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= ${ONLINE_WINDOW_MIN}
       ORDER BY RANDOM() LIMIT 1`
    )
    .get(t.id);
  if (!mm) return null;
  db.prepare('UPDATE tournaments SET middleman_id = ? WHERE id = ?').run(mm.id, t.id);
  notify(mm.id, 'tournament', `You've been assigned to hold the prize for tournament “${t.title}” (${t.prize}). You're in the tournament chat.`, '#tournaments');
  notify(t.host_id, 'tournament', `${mm.username} was assigned as prize middleman for “${t.title}” — hand them the prize to make the payout guaranteed.`, '#tournaments');
  return mm;
}

function processTournaments() {
  const due = db
    .prepare("SELECT * FROM tournaments WHERE status = 'open' AND julianday(signups_close_at) <= julianday('now')")
    .all();
  for (const t of due) {
    const players = db.prepare('SELECT user_id FROM tournament_players WHERE tournament_id = ?').all(t.id);
    if (players.length < MIN_PLAYERS) {
      db.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(t.id);
      players.forEach((p) => notify(p.user_id, 'tournament', `Tournament “${t.title}” was cancelled — not enough players signed up.`, '#tournaments'));
      continue;
    }
    db.prepare("UPDATE tournaments SET status = 'ongoing' WHERE id = ?").run(t.id);
    players.forEach((p) => notify(p.user_id, 'tournament', `🏆 Tournament “${t.title}” is starting — the group chat is open, come say hi!`, '#tournaments'));
    if (t.prize_mode === 'mm_held') assignPrizeMiddleman(t);
  }
  // Ongoing mm_held tournaments that still lack a middleman (none online at
  // start time) — keep trying until one comes online.
  const needMM = db
    .prepare("SELECT * FROM tournaments WHERE status = 'ongoing' AND prize_mode = 'mm_held' AND middleman_id IS NULL")
    .all();
  needMM.forEach(assignPrizeMiddleman);
}

let tournamentTimer = null;
function startTournamentJob() {
  if (tournamentTimer) return;
  processTournaments();
  tournamentTimer = setInterval(processTournaments, 30 * 1000);
}

module.exports = router;
module.exports.processTournaments = processTournaments;
module.exports.startTournamentJob = startTournamentJob;
