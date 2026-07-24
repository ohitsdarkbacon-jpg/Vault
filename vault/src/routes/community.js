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
// Traders Center — post your trade, the community calls W / F / L.
// ============================================================

const MAX_WFL_LEN = 500;
const WFL_DAILY_CAP = 10;

router.get('/wfl', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, u.username, u.is_verified,
        (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro,
        (SELECT COUNT(*) FROM wfl_votes v WHERE v.post_id = p.id AND v.vote = 'w') AS w_count,
        (SELECT COUNT(*) FROM wfl_votes v WHERE v.post_id = p.id AND v.vote = 'f') AS f_count,
        (SELECT COUNT(*) FROM wfl_votes v WHERE v.post_id = p.id AND v.vote = 'l') AS l_count,
        (SELECT vote FROM wfl_votes v WHERE v.post_id = p.id AND v.user_id = ?) AS my_vote
       FROM wfl_posts p JOIN users u ON u.id = p.user_id
       ORDER BY p.id DESC LIMIT 40`
    )
    .all(req.user ? req.user.id : 0);
  res.json({ posts: rows });
});

router.post('/wfl', requireAuth, (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Describe the trade first.' });
  if (body.length > MAX_WFL_LEN) return res.status(400).json({ error: `Keep it under ${MAX_WFL_LEN} characters.` });
  const image_url = req.body?.image_url ? String(req.body.image_url) : null;
  if (image_url && !(image_url.startsWith('/uploads/') || /^https?:\/\//.test(image_url))) {
    return res.status(400).json({ error: 'Image URL must be a valid http(s) link.' });
  }
  const today = db
    .prepare("SELECT COUNT(*) c FROM wfl_posts WHERE user_id = ? AND julianday(created_at) >= julianday('now','-1 day')")
    .get(req.user.id).c;
  if (today >= WFL_DAILY_CAP) return res.status(400).json({ error: `Easy — ${WFL_DAILY_CAP} trade posts per day max.` });
  const mod = moderateField(body, 'post');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const info = db
    .prepare('INSERT INTO wfl_posts (user_id, body, image_url, category) VALUES (?, ?, ?, ?)')
    .run(req.user.id, mod.clean, image_url, parseCategory(req.body?.category) || 'other');
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// Vote W / F / L. Voting the same letter again clears your vote; you can't
// rate your own trade.
router.post('/wfl/:id/vote', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM wfl_posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id === req.user.id) return res.status(400).json({ error: 'You can\'t rate your own trade — let the people speak.' });
  const vote = String(req.body?.vote || '').toLowerCase();
  if (!['w', 'f', 'l'].includes(vote)) return res.status(400).json({ error: 'Vote must be W, F, or L.' });
  const existing = db.prepare('SELECT vote FROM wfl_votes WHERE post_id = ? AND user_id = ?').get(p.id, req.user.id);
  if (existing && existing.vote === vote) {
    db.prepare('DELETE FROM wfl_votes WHERE post_id = ? AND user_id = ?').run(p.id, req.user.id);
    return res.json({ ok: true, my_vote: null });
  }
  db.prepare(
    `INSERT INTO wfl_votes (post_id, user_id, vote) VALUES (?, ?, ?)
     ON CONFLICT(post_id, user_id) DO UPDATE SET vote = excluded.vote, created_at = datetime('now')`
  ).run(p.id, req.user.id, vote);
  res.json({ ok: true, my_vote: vote });
});

router.delete('/wfl/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM wfl_posts WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found.' });
  if (p.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Not your post.' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wfl_votes WHERE post_id = ?').run(p.id);
    db.prepare('DELETE FROM wfl_posts WHERE id = ?').run(p.id);
  });
  tx();
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

// Section dock rooms + Vault Server text channels (all share the same
// slowmode + bot-check + moderation pipeline below).
const ROOMS = new Set(['marketplace', 'trading', 'tournaments', 'general', 'giveaways', 'help', 'off-topic', 'clips']);
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

// ============================================================
// Vault Server — a Discord-style hub. Text channels reuse the room
// chat above; voice channels reuse lobbies (see lobbies.js).
// ============================================================
router.get('/server/summary', (req, res) => {
  const online = db
    .prepare("SELECT COUNT(*) n FROM users WHERE last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= 5 AND is_banned = 0")
    .get().n;
  // Occupancy of each voice channel (open server-voice lobbies).
  const voice = db
    .prepare(
      `SELECT channel, COUNT(DISTINCT m.user_id) AS in_voice
       FROM lobbies l JOIN lobby_members m ON m.lobby_id = l.id
       WHERE l.channel IS NOT NULL AND l.status = 'open'
       GROUP BY channel`
    )
    .all();
  const voiceMap = {};
  voice.forEach((v) => { voiceMap[v.channel] = v.in_voice; });
  // A peek at who's around, newest-active first.
  const members = db
    .prepare(
      `SELECT username, avatar_url,
        (pro_until IS NOT NULL AND julianday(pro_until) > julianday('now')) AS pro
       FROM users
       WHERE last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= 5 AND is_banned = 0
       ORDER BY last_seen_at DESC LIMIT 20`
    )
    .all();
  res.json({ online, voice: voiceMap, members });
});

// ============================================================
// Global activity board — privacy-safe, aggregated by country.
// We only ever store a coarse ISO country code derived from the browser's
// timezone (never coordinates, never IP lookups), users can opt out
// entirely, and regions with fewer than K_ANON users are never shown.
// ============================================================
const K_ANON = 3;

// Compact IANA timezone → ISO-3166 country map covering common zones.
// Unknown zones simply leave the user unplaced — that's fine.
const TZ_COUNTRY = {
  'america/new_york': 'US', 'america/chicago': 'US', 'america/denver': 'US', 'america/phoenix': 'US',
  'america/los_angeles': 'US', 'america/anchorage': 'US', 'pacific/honolulu': 'US', 'america/detroit': 'US',
  'america/toronto': 'CA', 'america/vancouver': 'CA', 'america/edmonton': 'CA', 'america/winnipeg': 'CA', 'america/halifax': 'CA',
  'america/mexico_city': 'MX', 'america/tijuana': 'MX', 'america/monterrey': 'MX',
  'america/sao_paulo': 'BR', 'america/fortaleza': 'BR', 'america/manaus': 'BR', 'america/bahia': 'BR',
  'america/argentina/buenos_aires': 'AR', 'america/santiago': 'CL', 'america/bogota': 'CO', 'america/lima': 'PE',
  'america/caracas': 'VE', 'america/montevideo': 'UY', 'america/guayaquil': 'EC', 'america/la_paz': 'BO',
  'europe/london': 'GB', 'europe/dublin': 'IE', 'europe/paris': 'FR', 'europe/berlin': 'DE',
  'europe/madrid': 'ES', 'europe/rome': 'IT', 'europe/amsterdam': 'NL', 'europe/brussels': 'BE',
  'europe/lisbon': 'PT', 'europe/zurich': 'CH', 'europe/vienna': 'AT', 'europe/stockholm': 'SE',
  'europe/oslo': 'NO', 'europe/copenhagen': 'DK', 'europe/helsinki': 'FI', 'europe/warsaw': 'PL',
  'europe/prague': 'CZ', 'europe/budapest': 'HU', 'europe/bucharest': 'RO', 'europe/sofia': 'BG',
  'europe/athens': 'GR', 'europe/istanbul': 'TR', 'europe/kyiv': 'UA', 'europe/kiev': 'UA',
  'europe/moscow': 'RU', 'europe/belgrade': 'RS', 'europe/zagreb': 'HR', 'europe/bratislava': 'SK',
  'europe/vilnius': 'LT', 'europe/riga': 'LV', 'europe/tallinn': 'EE',
  'asia/tokyo': 'JP', 'asia/seoul': 'KR', 'asia/shanghai': 'CN', 'asia/hong_kong': 'HK',
  'asia/taipei': 'TW', 'asia/singapore': 'SG', 'asia/kuala_lumpur': 'MY', 'asia/bangkok': 'TH',
  'asia/jakarta': 'ID', 'asia/manila': 'PH', 'asia/ho_chi_minh': 'VN', 'asia/kolkata': 'IN', 'asia/calcutta': 'IN',
  'asia/karachi': 'PK', 'asia/dhaka': 'BD', 'asia/dubai': 'AE', 'asia/riyadh': 'SA', 'asia/qatar': 'QA',
  'asia/kuwait': 'KW', 'asia/jerusalem': 'IL', 'asia/amman': 'JO', 'asia/baghdad': 'IQ', 'asia/tehran': 'IR',
  'africa/cairo': 'EG', 'africa/lagos': 'NG', 'africa/johannesburg': 'ZA', 'africa/nairobi': 'KE',
  'africa/casablanca': 'MA', 'africa/algiers': 'DZ', 'africa/tunis': 'TN', 'africa/accra': 'GH',
  'australia/sydney': 'AU', 'australia/melbourne': 'AU', 'australia/brisbane': 'AU', 'australia/perth': 'AU',
  'australia/adelaide': 'AU', 'pacific/auckland': 'NZ',
};

// Client reports its timezone; we store only the mapped country (or clear it).
router.post('/my/region', requireAuth, (req, res) => {
  if (req.body?.hidden != null) {
    db.prepare('UPDATE users SET region_hidden = ? WHERE id = ?').run(req.body.hidden ? 1 : 0, req.user.id);
    if (req.body.hidden) db.prepare('UPDATE users SET region = NULL WHERE id = ?').run(req.user.id);
  }
  const tz = String(req.body?.tz || '').toLowerCase().slice(0, 60);
  const country = TZ_COUNTRY[tz] || null;
  const hidden = db.prepare('SELECT region_hidden FROM users WHERE id = ?').get(req.user.id).region_hidden;
  if (!hidden && country) db.prepare('UPDATE users SET region = ? WHERE id = ?').run(country, req.user.id);
  res.json({ ok: true, region: hidden ? null : country, hidden: !!hidden });
});

// Aggregated board. Every per-region figure respects opt-out + k-anonymity.
router.get('/activity-map', (req, res) => {
  const online_total = db
    .prepare("SELECT COUNT(*) n FROM users WHERE last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= 5 AND is_banned = 0")
    .get().n;
  const sales_24h = db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('paid','delivered','completed') AND julianday(created_at) > julianday('now', '-1 day')").get().n;
  const listings_24h = db.prepare("SELECT COUNT(*) n FROM listings WHERE julianday(created_at) > julianday('now', '-1 day')").get().n;
  const trades_open = db.prepare("SELECT COUNT(*) n FROM trade_posts WHERE status = 'open'").get().n;

  const regions = db
    .prepare(
      `SELECT region,
        COUNT(*) AS traders,
        SUM(CASE WHEN last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= 5 THEN 1 ELSE 0 END) AS online,
        (SELECT COUNT(*) FROM listings l JOIN users lu ON lu.id = l.seller_id
          WHERE lu.region = users.region AND lu.region_hidden = 0 AND julianday(l.created_at) > julianday('now', '-1 day')) AS listings_24h,
        (SELECT COUNT(*) FROM orders o JOIN users su ON su.id = o.seller_id
          WHERE su.region = users.region AND su.region_hidden = 0 AND o.status IN ('paid','delivered','completed')
            AND julianday(o.created_at) > julianday('now', '-1 day')) AS sales_24h
       FROM users
       WHERE region IS NOT NULL AND region_hidden = 0 AND is_banned = 0
       GROUP BY region HAVING COUNT(*) >= ${K_ANON}
       ORDER BY traders DESC LIMIT 30`
    )
    .all();

  res.json({ online_total, sales_24h, listings_24h, trades_open, regions });
});

module.exports = router;
