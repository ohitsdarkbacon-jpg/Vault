// Multi-person trade chains — cycles over open, opted-in trade posts where
// A → B → C (→ D) → A and everyone receives something their post asks for.
//
// Safety model:
//  - Discovery only *suggests* cycles; nothing is created until someone
//    proposes one, and the server re-validates the whole cycle from live data
//    at proposal time AND again at every confirmation.
//  - Terms (who gives what to whom) are snapshotted into chain members at
//    proposal, so they cannot change once people start confirming.
//  - Nothing is agreed until every member has individually confirmed.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');
const { tokens, overlap } = require('../lib/matching');

const router = express.Router();

const MAX_CHAIN = 4;
const MIN_CHAIN = 3;
const DISCOVER_POOL = 250;   // newest opted-in posts considered
const MAX_SUGGESTIONS = 8;
const ONLINE_WINDOW_MIN = 5; // matches the middleman-network "online" window

// Pick an online, approved middleman who isn't one of the chain's members.
function pickChainMiddleman(memberIds) {
  const placeholders = memberIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, username FROM users
       WHERE middleman_status = 'approved' AND is_banned = 0
         AND id NOT IN (${placeholders})
         AND last_seen_at IS NOT NULL
         AND (julianday('now') - julianday(last_seen_at)) * 24 * 60 <= ${ONLINE_WINDOW_MIN}
       ORDER BY RANDOM() LIMIT 1`
    )
    .get(...memberIds);
}

// Directed edge P→Q: Q's post wants something P is offering (P can give to Q).
function edge(p, q) {
  return p.user_id !== q.user_id && overlap(tokens(q.wants), tokens(p.offering)) > 0;
}

function loadPool() {
  return db
    .prepare(
      `SELECT t.id, t.user_id, t.offering, t.wants, t.category, u.username
       FROM trade_posts t JOIN users u ON u.id = t.user_id
       WHERE t.status = 'open' AND t.chain_ok = 1 ORDER BY t.id DESC LIMIT ?`
    )
    .all(DISCOVER_POOL);
}

// Re-validate a candidate cycle (array of live post rows in give-order)
// against current data: open, opted-in, distinct users, every hop matches.
function validCycle(posts) {
  if (posts.length < MIN_CHAIN || posts.length > MAX_CHAIN) return false;
  if (posts.some((p) => !p)) return false;
  const users = new Set(posts.map((p) => p.user_id));
  if (users.size !== posts.length) return false;
  for (let i = 0; i < posts.length; i++) {
    if (!edge(posts[i], posts[(i + 1) % posts.length])) return false;
  }
  return true;
}

// ---------- Discover candidate chains involving me ----------
router.get('/chains/discover', requireAuth, (req, res) => {
  const pool = loadPool();
  const mine = pool.filter((p) => p.user_id === req.user.id);
  if (!mine.length) {
    return res.json({ chains: [], reason: 'no_posts' }); // needs an opted-in open post
  }
  const found = [];
  const seen = new Set();

  // DFS from each of my posts, walking give-edges, closing back to the start.
  function dfs(path) {
    if (found.length >= MAX_SUGGESTIONS) return;
    const last = path[path.length - 1];
    if (path.length >= MIN_CHAIN && edge(last, path[0])) {
      const key = path.map((p) => p.id).sort((a, b) => a - b).join('-');
      if (!seen.has(key)) {
        seen.add(key);
        found.push(path.slice());
      }
    }
    if (path.length >= MAX_CHAIN) return;
    const usersInPath = new Set(path.map((p) => p.user_id));
    for (const q of pool) {
      if (usersInPath.has(q.user_id)) continue;
      if (edge(last, q)) dfs([...path, q]);
      if (found.length >= MAX_SUGGESTIONS) return;
    }
  }
  for (const start of mine) {
    dfs([start]);
    if (found.length >= MAX_SUGGESTIONS) break;
  }

  res.json({
    chains: found.map((cycle) => ({
      posts: cycle.map((p, i) => ({
        post_id: p.id,
        username: p.username,
        user_id: p.user_id,
        gives: p.offering,
        receives: cycle[(i - 1 + cycle.length) % cycle.length].offering,
      })),
    })),
  });
});

// ---------- Propose a chain (server re-validates everything) ----------
router.post('/chains', requireAuth, (req, res) => {
  const postIds = Array.isArray(req.body?.post_ids)
    ? req.body.post_ids.map((n) => parseInt(n, 10)).filter(Number.isInteger)
    : [];
  if (postIds.length < MIN_CHAIN || postIds.length > MAX_CHAIN) {
    return res.status(400).json({ error: `Chains are ${MIN_CHAIN}–${MAX_CHAIN} people.` });
  }
  if (new Set(postIds).size !== postIds.length) return res.status(400).json({ error: 'Duplicate posts in chain.' });

  const posts = postIds.map((id) =>
    db.prepare("SELECT t.*, u.username FROM trade_posts t JOIN users u ON u.id = t.user_id WHERE t.id = ? AND t.status = 'open' AND t.chain_ok = 1").get(id)
  );
  if (!validCycle(posts)) return res.status(400).json({ error: 'That chain is no longer possible — one of the posts changed or closed.' });
  if (!posts.some((p) => p.user_id === req.user.id)) return res.status(403).json({ error: 'You can only propose chains that include you.' });

  // One live chain per exact post set — stops spam re-proposals.
  const key = postIds.slice().sort((a, b) => a - b).join(',');
  const live = db
    .prepare("SELECT c.id FROM trade_chains c WHERE c.status IN ('proposed','confirmed')")
    .all()
    .find((c) => {
      const members = db.prepare('SELECT post_id FROM trade_chain_members WHERE chain_id = ?').all(c.id);
      return members.map((m) => m.post_id).sort((a, b) => a - b).join(',') === key;
    });
  if (live) return res.status(409).json({ error: 'This exact chain is already proposed.' });

  let chainId;
  db.transaction(() => {
    const info = db.prepare('INSERT INTO trade_chains (created_by) VALUES (?)').run(req.user.id);
    chainId = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO trade_chain_members (chain_id, user_id, post_id, position, gives, receives, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    posts.forEach((p, i) => {
      const receives = posts[(i - 1 + posts.length) % posts.length].offering;
      ins.run(chainId, p.user_id, p.id, i, p.offering, receives, p.user_id === req.user.id ? 1 : 0);
    });
  })();

  for (const p of posts) {
    if (p.user_id !== req.user.id) {
      notify(p.user_id, 'chain_proposed', `🔗 ${req.user.username} proposed a ${posts.length}-person trade chain including your "${p.offering}". Review and confirm it in Trading.`, '#trading');
    }
  }
  res.status(201).json({ ok: true, id: chainId });
});

// ---------- My chains ----------
function chainView(c, viewerId) {
  const members = db
    .prepare(
      `SELECT m.*, u.username, u.avatar_url FROM trade_chain_members m
       JOIN users u ON u.id = m.user_id WHERE m.chain_id = ? ORDER BY m.position`
    )
    .all(c.id);
  const mm = c.middleman_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(c.middleman_id) : null;
  return {
    id: c.id,
    status: c.status,
    created_at: c.created_at,
    mm_state: c.mm_state,
    middleman: mm ? mm.username : null,
    room_open: ['confirmed', 'completed'].includes(c.status), // group chat available
    is_middleman: c.middleman_id === viewerId,
    is_member: members.some((m) => m.user_id === viewerId),
    members: members.map((m) => ({
      username: m.username,
      avatar_url: m.avatar_url,
      gives: m.gives,
      receives: m.receives,
      confirmed: !!m.confirmed,
      done: !!m.done,
      is_me: m.user_id === viewerId,
    })),
    my_confirmed: !!members.find((m) => m.user_id === viewerId)?.confirmed,
    my_done: !!members.find((m) => m.user_id === viewerId)?.done,
  };
}

router.get('/chains/mine', requireAuth, (req, res) => {
  // Chains I'm a trader in, plus any I've been assigned to middleman.
  const chains = db
    .prepare(
      `SELECT c.* FROM trade_chains c
       WHERE EXISTS (SELECT 1 FROM trade_chain_members m WHERE m.chain_id = c.id AND m.user_id = ?)
          OR c.middleman_id = ?
       ORDER BY c.id DESC LIMIT 30`
    )
    .all(req.user.id, req.user.id);
  res.json({ chains: chains.map((c) => chainView(c, req.user.id)) });
});

function memberOf(chainId, userId) {
  return db.prepare('SELECT * FROM trade_chain_members WHERE chain_id = ? AND user_id = ?').get(chainId, userId);
}

// ---------- Confirm ----------
router.post('/chains/:id/confirm', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !memberOf(chain.id, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (chain.status !== 'proposed') return res.status(400).json({ error: 'This chain is no longer awaiting confirmations.' });

  // Underlying posts must all still be open — otherwise the chain can't happen.
  const members = db.prepare('SELECT * FROM trade_chain_members WHERE chain_id = ?').all(chain.id);
  const stillOpen = members.every((m) => db.prepare("SELECT 1 FROM trade_posts WHERE id = ? AND status = 'open'").get(m.post_id));
  if (!stillOpen) {
    db.prepare("UPDATE trade_chains SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(chain.id);
    return res.status(409).json({ error: 'A post in this chain was closed — the chain has been cancelled.' });
  }

  db.prepare('UPDATE trade_chain_members SET confirmed = 1 WHERE chain_id = ? AND user_id = ?').run(chain.id, req.user.id);
  const left = db.prepare('SELECT COUNT(*) n FROM trade_chain_members WHERE chain_id = ? AND confirmed = 0').get(chain.id).n;
  if (left === 0) {
    db.prepare("UPDATE trade_chains SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?").run(chain.id);
    for (const m of members) {
      notify(m.user_id, 'chain_confirmed', `🔗 Everyone confirmed your trade chain — request a middleman to oversee the hand-offs, then mark your part done.`, '#trading');
    }
  }
  res.json({ ok: true, all_confirmed: left === 0 });
});

// ---------- Request a middleman to oversee the hand-offs ----------
// A confirmed chain must have a middleman requested before anyone can mark
// their hand-off done. Reuses the approved-middleman network; the assigned
// MM is never one of the traders in the chain.
router.post('/chains/:id/request-mm', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !memberOf(chain.id, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (chain.status !== 'confirmed') return res.status(400).json({ error: 'Everyone must confirm the chain first.' });
  if (chain.mm_state === 'assigned') {
    const cur = db.prepare('SELECT username FROM users WHERE id = ?').get(chain.middleman_id);
    return res.json({ ok: true, middleman: cur ? cur.username : null, already: true });
  }
  const members = db.prepare('SELECT user_id FROM trade_chain_members WHERE chain_id = ?').all(chain.id).map((m) => m.user_id);
  const mm = pickChainMiddleman(members);
  if (!mm) {
    return res.status(200).json({ ok: false, error: 'No middlemen are online right now — try again shortly, or waive the middleman if you all trust each other.' });
  }
  db.prepare("UPDATE trade_chains SET middleman_id = ?, mm_state = 'assigned', updated_at = datetime('now') WHERE id = ?").run(mm.id, chain.id);
  notify(mm.id, 'chain_mm', `⚖️ You've been requested to middleman a ${members.length}-person trade chain (#${chain.id}). Coordinate the hand-offs in order so everyone gets their item safely.`, '#trading');
  for (const uid of members) {
    if (uid !== req.user.id) notify(uid, 'chain_mm', `⚖️ ${mm.username} is middlemanning your trade chain — wait for their go-ahead before handing anything over.`, '#trading');
  }
  res.status(201).json({ ok: true, middleman: mm.username });
});

// ---------- Waive the middleman (only when none are online) ----------
router.post('/chains/:id/waive-mm', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !memberOf(chain.id, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (chain.status !== 'confirmed') return res.status(400).json({ error: 'Everyone must confirm the chain first.' });
  if (chain.mm_state !== 'none') return res.status(400).json({ error: 'A middleman decision was already made.' });
  db.prepare("UPDATE trade_chains SET mm_state = 'waived', updated_at = datetime('now') WHERE id = ?").run(chain.id);
  const members = db.prepare('SELECT user_id FROM trade_chain_members WHERE chain_id = ?').all(chain.id);
  for (const m of members) {
    if (m.user_id !== req.user.id) notify(m.user_id, 'chain_mm', `⚠️ ${req.user.username} chose to proceed without a middleman on your trade chain — only continue if you trust everyone involved.`, '#trading');
  }
  res.json({ ok: true });
});

// ---------- Cancel (any member, any time before completion) ----------
router.post('/chains/:id/cancel', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !memberOf(chain.id, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (!['proposed', 'confirmed'].includes(chain.status)) return res.status(400).json({ error: 'This chain is already finished.' });
  db.prepare("UPDATE trade_chains SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(chain.id);
  const members = db.prepare('SELECT user_id FROM trade_chain_members WHERE chain_id = ?').all(chain.id);
  for (const m of members) {
    if (m.user_id !== req.user.id) notify(m.user_id, 'chain_cancelled', `🔗 ${req.user.username} cancelled a trade chain you were in.`, '#trading');
  }
  res.json({ ok: true });
});

// ---------- Mark my hand-off done; all done → completed ----------
router.post('/chains/:id/done', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !memberOf(chain.id, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (chain.status !== 'confirmed') return res.status(400).json({ error: 'The chain must be fully confirmed first.' });
  // A middleman must be requested (or explicitly waived) before hand-offs.
  if (chain.mm_state === 'none') return res.status(400).json({ error: 'Request a middleman for the hand-offs first.' });
  db.prepare('UPDATE trade_chain_members SET done = 1 WHERE chain_id = ? AND user_id = ?').run(chain.id, req.user.id);
  const left = db.prepare('SELECT COUNT(*) n FROM trade_chain_members WHERE chain_id = ? AND done = 0').get(chain.id).n;
  if (left === 0) {
    db.transaction(() => {
      db.prepare("UPDATE trade_chains SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(chain.id);
      // Close the underlying posts — those items have been traded away.
      const members = db.prepare('SELECT user_id, post_id FROM trade_chain_members WHERE chain_id = ?').all(chain.id);
      for (const m of members) {
        db.prepare("UPDATE trade_posts SET status = 'closed' WHERE id = ?").run(m.post_id);
        notify(m.user_id, 'chain_completed', '🔗 Trade chain completed — everyone marked their hand-off done. 🎉', '#trading');
      }
    })();
  }
  res.json({ ok: true, completed: left === 0 });
});

// ---------- Group chat room (traders + the assigned middleman) ----------
// Opens once the chain is confirmed so everyone — including the middleman —
// can agree on a server, the hand-off order, and confirm receipts together.
function canAccessRoom(chain, userId) {
  if (chain.middleman_id === userId) return true;
  return !!db.prepare('SELECT 1 FROM trade_chain_members WHERE chain_id = ? AND user_id = ?').get(chain.id, userId);
}

router.get('/chains/:id/messages', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !canAccessRoom(chain, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (!['confirmed', 'completed'].includes(chain.status)) {
    return res.status(400).json({ error: 'The chat opens once everyone confirms the chain.' });
  }
  const after = parseInt(req.query.after, 10) || 0;
  const messages = db
    .prepare(
      `SELECT m.id, m.sender_id, m.body, m.created_at, u.username AS sender_name,
        (m.sender_id = ?) AS mine, (m.sender_id = ?) AS from_mm
       FROM trade_chain_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.chain_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200`
    )
    .all(req.user.id, chain.middleman_id || 0, chain.id, after);
  const memberNames = db
    .prepare('SELECT u.username FROM trade_chain_members m JOIN users u ON u.id = m.user_id WHERE m.chain_id = ? ORDER BY m.position')
    .all(chain.id)
    .map((r) => r.username);
  const mm = chain.middleman_id ? db.prepare('SELECT username FROM users WHERE id = ?').get(chain.middleman_id) : null;
  res.json({
    messages,
    room: {
      id: chain.id,
      status: chain.status,
      members: memberNames,
      middleman: mm ? mm.username : null,
      can_post: chain.status === 'confirmed',
    },
  });
});

router.post('/chains/:id/messages', requireAuth, (req, res) => {
  const chain = db.prepare('SELECT * FROM trade_chains WHERE id = ?').get(req.params.id);
  if (!chain || !canAccessRoom(chain, req.user.id)) return res.status(404).json({ error: 'Chain not found.' });
  if (chain.status !== 'confirmed') {
    return res.status(400).json({ error: 'This chat is read-only now.' });
  }
  const body = String(req.body?.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  const mod = moderateField(body, 'message');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const info = db
    .prepare('INSERT INTO trade_chain_messages (chain_id, sender_id, body) VALUES (?, ?, ?)')
    .run(chain.id, req.user.id, mod.clean);
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

module.exports = router;
