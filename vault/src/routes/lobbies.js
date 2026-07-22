const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

const MAX_TITLE_LEN = 80;
const MAX_GAME_LEN = 40;
const MAX_NOTES_LEN = 200;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 20;
const MAX_HOSTED = 2;
const IDLE_CLOSE_MIN = 30; // lobbies with no activity for 30 min auto-close
const REGIONS = new Set(['any', 'na-east', 'na-west', 'eu', 'asia', 'oceania', 'sa']);
const ROOM_MSG_LEN = 300;

// Voice is built in (WebRTC mesh). voice_room stays as a stable per-lobby
// id we can key on if needed; audio is peer-to-peer, relayed through the
// signalling mailbox below.
function newVoiceRoom() {
  return `VaultLobby-${crypto.randomBytes(6).toString('hex')}`;
}
const VOICE_WINDOW_S = 15; // "in voice" if heartbeat within this many seconds

function voiceRoster(lobbyId, excludeUserId = 0) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url
       FROM lobby_members m JOIN users u ON u.id = m.user_id
       WHERE m.lobby_id = ? AND m.user_id != ?
         AND m.voice_at IS NOT NULL AND (julianday('now') - julianday(m.voice_at)) * 86400 <= ?
       ORDER BY u.id ASC`
    )
    .all(lobbyId, excludeUserId, VOICE_WINDOW_S);
}

const lobbyQuery = `
  SELECT l.*, u.username AS host_name,
    (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS host_pro,
    (SELECT COUNT(*) FROM lobby_members m WHERE m.lobby_id = l.id) AS player_count
  FROM lobbies l JOIN users u ON u.id = l.host_id
`;

function isMember(lobbyId, userId) {
  return !!db.prepare('SELECT 1 FROM lobby_members WHERE lobby_id = ? AND user_id = ?').get(lobbyId, userId);
}
function touch(lobbyId) {
  db.prepare("UPDATE lobbies SET last_active_at = datetime('now') WHERE id = ?").run(lobbyId);
}
function shape(l, userId) {
  const joined = userId ? isMember(l.id, userId) : false;
  const out = {
    id: l.id, title: l.title, game: l.game, notes: l.notes, region: l.region,
    max_players: l.max_players, player_count: l.player_count, status: l.status,
    host_id: l.host_id, host_name: l.host_name, host_pro: l.host_pro,
    private: !!l.join_code, joined, created_at: l.created_at,
  };
  // The member roster is only exposed to people in the lobby.
  if (joined) {
    out.members = db
      .prepare(
        `SELECT u.id, u.username, u.avatar_url,
          (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro
         FROM lobby_members m JOIN users u ON u.id = m.user_id
         WHERE m.lobby_id = ? ORDER BY m.joined_at ASC`
      )
      .all(l.id);
  }
  return out;
}

// ---------- Browse (user lobbies only; server-voice channels excluded) ----------
router.get('/lobbies', (req, res) => {
  closeIdleLobbies();
  const rows = db
    .prepare(`${lobbyQuery} WHERE l.status = 'open' AND l.channel IS NULL ORDER BY l.last_active_at DESC LIMIT 40`)
    .all();
  res.json({ lobbies: rows.map((l) => shape(l, req.user ? req.user.id : null)) });
});

// ---------- Vault Server voice channels ----------
// Join the persistent lobby behind a server voice channel, or spin one up.
// These don't count toward the host cap and don't auto-close on host-leave
// (only when empty) — they behave like Discord voice channels.
const VOICE_CHANNELS = {
  general: 'General VC',
  games: 'Games VC',
  trading: 'Trading VC',
  chill: 'Chill VC',
};
router.post('/server/voice/:channel/join', requireAuth, (req, res) => {
  const channel = String(req.params.channel);
  if (!VOICE_CHANNELS[channel]) return res.status(404).json({ error: 'Voice channel not found.' });
  let l = db.prepare("SELECT * FROM lobbies WHERE channel = ? AND status = 'open' ORDER BY id ASC LIMIT 1").get(channel);
  if (!l) {
    const info = db
      .prepare(
        `INSERT INTO lobbies (host_id, title, game, region, max_players, voice_room, channel)
         VALUES (?, ?, ?, 'any', 20, ?, ?)`
      )
      .run(req.user.id, VOICE_CHANNELS[channel], 'Vault Server', newVoiceRoom(), channel);
    l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(info.lastInsertRowid);
  }
  if (!isMember(l.id, req.user.id)) {
    const count = db.prepare('SELECT COUNT(*) n FROM lobby_members WHERE lobby_id = ?').get(l.id).n;
    if (count >= l.max_players) return res.status(400).json({ error: 'This voice channel is full.' });
    db.prepare('INSERT INTO lobby_members (lobby_id, user_id) VALUES (?, ?)').run(l.id, req.user.id);
  }
  touch(l.id);
  res.json({ ok: true, id: l.id });
});

// ---------- Host ----------
router.post('/lobbies', requireAuth, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give your lobby a title.' });
  if (title.length > MAX_TITLE_LEN) return res.status(400).json({ error: `Title must be ${MAX_TITLE_LEN} characters or fewer.` });
  const game = String(b.game || '').trim();
  if (!game) return res.status(400).json({ error: 'Which game are you playing?' });
  if (game.length > MAX_GAME_LEN) return res.status(400).json({ error: `Game name must be ${MAX_GAME_LEN} characters or fewer.` });
  const notes = String(b.notes || '').trim();
  if (notes.length > MAX_NOTES_LEN) return res.status(400).json({ error: `Notes must be ${MAX_NOTES_LEN} characters or fewer.` });
  const region = REGIONS.has(String(b.region)) ? String(b.region) : 'any';
  const maxPlayers = parseInt(b.max_players, 10);
  if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
    return res.status(400).json({ error: `Player limit must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}.` });
  }

  const active = db.prepare("SELECT COUNT(*) n FROM lobbies WHERE host_id = ? AND status = 'open' AND channel IS NULL").get(req.user.id).n;
  if (active >= MAX_HOSTED) return res.status(400).json({ error: `You can host ${MAX_HOSTED} lobbies at once — close one first.` });

  const modTitle = moderateField(title, 'title');
  if (!modTitle.ok) return res.status(400).json({ error: modTitle.error });
  const modGame = moderateField(game, 'game');
  if (!modGame.ok) return res.status(400).json({ error: modGame.error });
  const modNotes = moderateField(notes || null, 'notes');
  if (!modNotes.ok) return res.status(400).json({ error: modNotes.error });

  // Private lobbies get a short join code shared out-of-band.
  const joinCode = b.private ? crypto.randomBytes(3).toString('hex').toUpperCase() : null;

  const info = db
    .prepare(
      `INSERT INTO lobbies (host_id, title, game, notes, region, max_players, voice_room, join_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, modTitle.clean, modGame.clean, modNotes.clean || null, region, maxPlayers, newVoiceRoom(), joinCode);
  db.prepare('INSERT INTO lobby_members (lobby_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.user.id);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, join_code: joinCode });
});

// ---------- Join / leave ----------
router.post('/lobbies/:id/join', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.id);
  if (!l || l.status !== 'open') return res.status(404).json({ error: 'Lobby not found or closed.' });
  if (isMember(l.id, req.user.id)) return res.json({ ok: true }); // idempotent
  if (l.join_code && String(req.body?.code || '').toUpperCase() !== l.join_code) {
    return res.status(403).json({ error: 'Wrong join code for this private lobby.' });
  }
  const count = db.prepare('SELECT COUNT(*) n FROM lobby_members WHERE lobby_id = ?').get(l.id).n;
  if (count >= l.max_players) return res.status(400).json({ error: 'This lobby is full.' });
  db.prepare('INSERT INTO lobby_members (lobby_id, user_id) VALUES (?, ?)').run(l.id, req.user.id);
  touch(l.id);
  res.json({ ok: true });
});

router.post('/lobbies/:id/leave', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Lobby not found.' });
  db.prepare('DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?').run(l.id, req.user.id);
  const remaining = db.prepare('SELECT user_id FROM lobby_members WHERE lobby_id = ? ORDER BY joined_at ASC').all(l.id);
  // Server voice channels persist until empty (Discord-style); user lobbies
  // also close when the host leaves.
  if (remaining.length === 0 || (!l.channel && l.host_id === req.user.id)) {
    db.prepare("UPDATE lobbies SET status = 'closed' WHERE id = ?").run(l.id);
  } else {
    touch(l.id);
  }
  res.json({ ok: true });
});

router.post('/lobbies/:id/close', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Lobby not found.' });
  if (l.host_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the host can close this lobby.' });
  db.prepare("UPDATE lobbies SET status = 'closed' WHERE id = ?").run(l.id);
  res.json({ ok: true });
});

// A single lobby (roster + voice url refresh for members).
router.get('/lobbies/:id', (req, res) => {
  const l = db.prepare(`${lobbyQuery} WHERE l.id = ?`).get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Lobby not found.' });
  res.json({ lobby: shape(l, req.user ? req.user.id : null) });
});

// ---------- Lobby chat (members only) ----------
router.get('/lobbies/:id/messages', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.id);
  if (!l || !(isMember(l.id, req.user.id) || req.user.is_admin)) return res.status(404).json({ error: 'Lobby not found.' });
  const after = parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT m.id, m.body, m.created_at, u.username AS sender_name,
        (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro,
        (m.sender_id = ?) AS mine, (m.sender_id = ?) AS from_host
       FROM lobby_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.lobby_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 100`
    )
    .all(req.user.id, l.host_id, l.id, after);
  res.json({ messages });
});

router.post('/lobbies/:id/messages', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.id);
  if (!l || !isMember(l.id, req.user.id)) return res.status(404).json({ error: 'Lobby not found.' });
  if (l.status !== 'open') return res.status(400).json({ error: 'This lobby has closed.' });
  const body = String(req.body?.body || '').trim().slice(0, ROOM_MSG_LEN);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const info = db.prepare('INSERT INTO lobby_messages (lobby_id, sender_id, body) VALUES (?, ?, ?)').run(l.id, req.user.id, mod.clean);
  touch(l.id);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ============================================================
// Built-in voice — WebRTC mesh signalled over polling
// ============================================================
function requireMember(req, res) {
  const l = db.prepare('SELECT * FROM lobbies WHERE id = ?').get(req.params.id);
  if (!l || !isMember(l.id, req.user.id)) { res.status(404).json({ error: 'Lobby not found.' }); return null; }
  return l;
}

// Announce you're in voice; returns everyone else currently in voice so the
// newcomer knows who to negotiate with.
router.post('/lobbies/:id/voice/join', requireAuth, (req, res) => {
  const l = requireMember(req, res); if (!l) return;
  db.prepare("UPDATE lobby_members SET voice_at = datetime('now') WHERE lobby_id = ? AND user_id = ?").run(l.id, req.user.id);
  touch(l.id);
  res.json({ ok: true, self_id: req.user.id, peers: voiceRoster(l.id, req.user.id) });
});

// Keep-alive; returns the live voice roster so clients add/drop peers.
router.post('/lobbies/:id/voice/heartbeat', requireAuth, (req, res) => {
  const l = requireMember(req, res); if (!l) return;
  db.prepare("UPDATE lobby_members SET voice_at = datetime('now') WHERE lobby_id = ? AND user_id = ?").run(l.id, req.user.id);
  res.json({ ok: true, peers: voiceRoster(l.id, req.user.id) });
});

router.post('/lobbies/:id/voice/leave', requireAuth, (req, res) => {
  const l = requireMember(req, res); if (!l) return;
  db.prepare('UPDATE lobby_members SET voice_at = NULL WHERE lobby_id = ? AND user_id = ?').run(l.id, req.user.id);
  db.prepare('DELETE FROM lobby_signals WHERE lobby_id = ? AND (from_id = ? OR to_id = ?)').run(l.id, req.user.id, req.user.id);
  res.json({ ok: true });
});

// Relay one signalling message (SDP offer/answer or ICE candidate) to a peer.
router.post('/lobbies/:id/signal', requireAuth, (req, res) => {
  const l = requireMember(req, res); if (!l) return;
  const to = parseInt(req.body?.to, 10);
  const kind = String(req.body?.kind || '');
  if (!['offer', 'answer', 'ice'].includes(kind)) return res.status(400).json({ error: 'Bad signal kind.' });
  if (!isMember(l.id, to)) return res.status(400).json({ error: 'Peer not in lobby.' });
  const payload = JSON.stringify(req.body?.payload ?? null).slice(0, 20000);
  db.prepare('INSERT INTO lobby_signals (lobby_id, from_id, to_id, kind, payload) VALUES (?, ?, ?, ?, ?)').run(l.id, req.user.id, to, kind, payload);
  res.status(201).json({ ok: true });
});

// Drain my signalling mailbox (consumed on read).
router.get('/lobbies/:id/signal', requireAuth, (req, res) => {
  const l = requireMember(req, res); if (!l) return;
  const rows = db
    .prepare('SELECT id, from_id, kind, payload FROM lobby_signals WHERE lobby_id = ? AND to_id = ? ORDER BY id ASC LIMIT 100')
    .all(l.id, req.user.id);
  if (rows.length) {
    db.prepare('DELETE FROM lobby_signals WHERE lobby_id = ? AND to_id = ? AND id <= ?').run(l.id, req.user.id, rows[rows.length - 1].id);
  }
  res.json({ signals: rows.map((s) => ({ id: s.id, from: s.from_id, kind: s.kind, payload: JSON.parse(s.payload) })) });
});

// ---------- Idle cleanup ----------
function closeIdleLobbies() {
  db.prepare(
    `UPDATE lobbies SET status = 'closed'
     WHERE status = 'open' AND (julianday('now') - julianday(last_active_at)) * 24 * 60 >= ?`
  ).run(IDLE_CLOSE_MIN);
  // Undelivered signals older than 2 min are stale (peer went away).
  db.prepare("DELETE FROM lobby_signals WHERE (julianday('now') - julianday(created_at)) * 86400 >= 120").run();
}
let idleTimer = null;
function startLobbyJob() {
  if (idleTimer) return;
  closeIdleLobbies();
  idleTimer = setInterval(closeIdleLobbies, 5 * 60 * 1000);
}

module.exports = router;
module.exports.startLobbyJob = startLobbyJob;
module.exports.closeIdleLobbies = closeIdleLobbies;
