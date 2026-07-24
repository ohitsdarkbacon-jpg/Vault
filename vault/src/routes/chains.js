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
const { tokens, overlap } = require('../lib/matching');

const router = express.Router();

const MAX_CHAIN = 4;
const MIN_CHAIN = 3;
const DISCOVER_POOL = 250;   // newest opted-in posts considered
const MAX_SUGGESTIONS = 8;

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
  return {
    id: c.id,
    status: c.status,
    created_at: c.created_at,
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
  const chains = db
    .prepare(
      `SELECT c.* FROM trade_chains c
       JOIN trade_chain_members m ON m.chain_id = c.id AND m.user_id = ?
       ORDER BY c.id DESC LIMIT 30`
    )
    .all(req.user.id);
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
      notify(m.user_id, 'chain_confirmed', `🔗 Everyone confirmed your trade chain — coordinate the hand-offs, then mark your part done. Use a middleman for high-value items.`, '#trading');
    }
  }
  res.json({ ok: true, all_confirmed: left === 0 });
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

module.exports = router;
