const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');
const {
  parsePagination,
  parsePriceCents,
  escapeLike,
  buildFtsMatchQuery,
  cleanQueryString,
} = require('../lib/search');

const router = express.Router();

const MAX_TITLE_LEN = 140;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_DURATION_MINUTES = 30 * 24 * 60; // 30 days

const auctionQuery = `
  SELECT a.*, u.username AS seller_name, b.username AS current_bidder_name
  FROM auctions a
  JOIN users u ON u.id = a.seller_id
  LEFT JOIN users b ON b.id = a.current_bidder_id
`;

const AUCTION_SORTS = {
  ending_soon: 'a.ends_at ASC',
  newest: 'a.created_at DESC',
  price_asc: 'COALESCE(a.current_bid_cents, a.starting_bid_cents) ASC',
  price_desc: 'COALESCE(a.current_bid_cents, a.starting_bid_cents) DESC',
};

function isValidImageUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// GET /api/auctions?q=&min_price=&max_price=&sort=&page=&limit=
router.get('/', (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const q = cleanQueryString(req.query.q);
  const minPrice = parsePriceCents(req.query.min_price);
  const maxPrice = parsePriceCents(req.query.max_price);

  const conditions = ["a.status = 'live'"];
  const params = [];
  if (minPrice != null) { conditions.push('COALESCE(a.current_bid_cents, a.starting_bid_cents) >= ?'); params.push(minPrice); }
  if (maxPrice != null) { conditions.push('COALESCE(a.current_bid_cents, a.starting_bid_cents) <= ?'); params.push(maxPrice); }

  const sortKey = req.query.sort && AUCTION_SORTS[req.query.sort] ? req.query.sort : (q ? 'relevance' : 'ending_soon');
  const orderBy = AUCTION_SORTS[sortKey] || AUCTION_SORTS.ending_soon;

  let rows = [];
  let total = 0;

  if (q && db.ftsAvailable) {
    const ftsQuery = buildFtsMatchQuery(q);
    if (ftsQuery) {
      const extraWhere = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      const orderClause = sortKey === 'relevance' ? 'rank ASC' : orderBy;
      rows = db
        .prepare(
          `SELECT a.*, u.username AS seller_name, b.username AS current_bidder_name, bm25(auctions_fts) AS rank
           FROM auctions_fts
           JOIN auctions a ON a.id = auctions_fts.rowid
           JOIN users u ON u.id = a.seller_id
           LEFT JOIN users b ON b.id = a.current_bidder_id
           WHERE auctions_fts MATCH ? ${extraWhere}
           ORDER BY ${orderClause}
           LIMIT ? OFFSET ?`
        )
        .all(ftsQuery, ...params, limit, offset);
      total = db
        .prepare(
          `SELECT COUNT(*) c FROM auctions_fts
           JOIN auctions a ON a.id = auctions_fts.rowid
           WHERE auctions_fts MATCH ? ${extraWhere}`
        )
        .get(ftsQuery, ...params).c;
    }
  } else if (q) {
    const likeTerm = `%${escapeLike(q)}%`;
    conditions.push("(a.title LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\')");
    params.push(likeTerm, likeTerm);
    const where = conditions.join(' AND ');
    rows = db.prepare(`${auctionQuery} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    total = db.prepare(`SELECT COUNT(*) c FROM auctions a WHERE ${where}`).get(...params).c;
  } else {
    const where = conditions.join(' AND ');
    rows = db.prepare(`${auctionQuery} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    total = db.prepare(`SELECT COUNT(*) c FROM auctions a WHERE ${where}`).get(...params).c;
  }

  res.json({
    auctions: rows,
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
  });
});

router.post('/', requireAuth, (req, res) => {
  const { description, image_url, starting_bid_cents, min_increment_cents, duration_minutes } = req.body || {};
  const title = req.body && req.body.title != null ? String(req.body.title).trim() : '';
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  if (title.length > MAX_TITLE_LEN) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE_LEN} characters or fewer.` });
  }
  if (description != null && String(description).length > MAX_DESCRIPTION_LEN) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION_LEN} characters or fewer.` });
  }
  if (!Number.isInteger(starting_bid_cents) || starting_bid_cents <= 0) {
    return res.status(400).json({ error: 'Starting bid must be a positive amount.' });
  }
  if (!isValidImageUrl(image_url)) {
    return res.status(400).json({ error: 'Image URL must be a valid http(s) link.' });
  }

  // Content moderation: reject hard-blocked terms, mask mild profanity.
  const modTitle = moderateField(title, 'title');
  if (!modTitle.ok) return res.status(400).json({ error: modTitle.error });
  const modDesc = moderateField(description ? String(description).trim() : null, 'description');
  if (!modDesc.ok) return res.status(400).json({ error: modDesc.error });

  let minutes = Number.isInteger(duration_minutes) && duration_minutes > 0 ? duration_minutes : 1440;
  minutes = Math.min(minutes, MAX_DURATION_MINUTES);
  const endsAt = new Date(Date.now() + minutes * 60000).toISOString();

  const info = db
    .prepare(
      `INSERT INTO auctions (seller_id, title, description, image_url, starting_bid_cents, min_increment_cents, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      modTitle.clean,
      modDesc.clean || null,
      image_url || null,
      starting_bid_cents,
      Number.isInteger(min_increment_cents) && min_increment_cents > 0 ? min_increment_cents : 100,
      endsAt
    );
  const auction = db.prepare(`${auctionQuery} WHERE a.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ auction });
});

router.get('/:id', (req, res) => {
  const auction = db.prepare(`${auctionQuery} WHERE a.id = ?`).get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  res.json({ auction });
});

router.post('/:id/bid', requireAuth, (req, res) => {
  const { amount_cents } = req.body || {};
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return res.status(400).json({ error: 'Enter a valid bid amount.' });
  }

  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'live') return res.status(400).json({ error: 'This auction has ended.' });
  if (new Date(auction.ends_at) <= new Date()) {
    return res.status(400).json({ error: 'This auction has ended.' });
  }
  if (auction.seller_id === req.user.id) {
    return res.status(400).json({ error: "You can't bid on your own auction." });
  }

  const floor = auction.current_bid_cents || auction.starting_bid_cents;
  const minAcceptable =
    auction.current_bid_cents == null ? auction.starting_bid_cents : floor + auction.min_increment_cents;

  if (amount_cents < minAcceptable) {
    return res.status(400).json({
      error: `Bid must be at least $${(minAcceptable / 100).toFixed(2)}.`,
    });
  }

  // Anti-sniping: a bid landing in the final 2 minutes pushes the end time
  // out by 2 minutes, so auctions can't be stolen at the buzzer.
  const SNIPE_WINDOW_MS = 2 * 60 * 1000;
  const msLeft = new Date(auction.ends_at) - new Date();
  const newEndsAt = msLeft < SNIPE_WINDOW_MS
    ? new Date(Date.now() + SNIPE_WINDOW_MS).toISOString()
    : auction.ends_at;

  const previousBidderId = auction.current_bidder_id;

  const tx = db.transaction(() => {
    db.prepare(
      'UPDATE auctions SET current_bid_cents = ?, current_bidder_id = ?, ends_at = ? WHERE id = ?'
    ).run(amount_cents, req.user.id, newEndsAt, auction.id);
    db.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents) VALUES (?, ?, ?)').run(
      auction.id,
      req.user.id,
      amount_cents
    );
  });
  tx();

  if (previousBidderId && previousBidderId !== req.user.id) {
    notify(
      previousBidderId,
      'outbid',
      `You've been outbid on "${auction.title}" — the bid is now $${(amount_cents / 100).toFixed(2)}.`,
      `#auction-${auction.id}`
    );
  }

  const updated = db.prepare(`${auctionQuery} WHERE a.id = ?`).get(auction.id);
  res.json({ auction: updated, extended: newEndsAt !== auction.ends_at });
});

// Bid history for an auction (public)
router.get('/:id/bids', (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.amount_cents, b.created_at, u.username AS bidder_name
       FROM bids b JOIN users u ON u.id = b.bidder_id
       WHERE b.auction_id = ? ORDER BY b.id DESC LIMIT 25`
    )
    .all(req.params.id);
  res.json({ bids: rows });
});

// Seller cancels their own auction — only while it has no bids
router.post('/:id/cancel', requireAuth, (req, res) => {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction || auction.seller_id !== req.user.id) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'live') return res.status(400).json({ error: 'Only live auctions can be cancelled.' });
  if (auction.current_bidder_id) return res.status(400).json({ error: "You can't cancel an auction that already has bids." });
  db.prepare("UPDATE auctions SET status = 'cancelled' WHERE id = ?").run(auction.id);
  res.json({ ok: true });
});

module.exports = router;
