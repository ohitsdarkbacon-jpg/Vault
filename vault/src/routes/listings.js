const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeOrderAmounts } = require('../lib/fees');
const { notify } = require('../lib/notify');
const { moderateField } = require('../lib/moderation');
const { acceptedOfferFor, settleOffersForListing } = require('../lib/fulfillOrder');
const {
  parsePagination,
  parsePriceCents,
  parseCategory,
  escapeLike,
  buildFtsMatchQuery,
  cleanQueryString,
} = require('../lib/search');

const router = express.Router();

const MAX_TITLE_LEN = 140;
const MAX_DESCRIPTION_LEN = 2000;

const listingQuery = `
  SELECT l.*, u.username AS seller_name, u.is_verified AS seller_verified,
    (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS seller_pro
  FROM listings l JOIN users u ON u.id = l.seller_id
`;

const LISTING_SORTS = {
  newest: 'l.created_at DESC',
  price_asc: 'l.price_cents ASC',
  price_desc: 'l.price_cents DESC',
};

function isValidImageUrl(url) {
  if (!url) return true; // optional field
  // Images uploaded via POST /api/uploads come back as a relative path.
  if (url.startsWith('/uploads/')) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// GET /api/listings?q=&min_price=&max_price=&sort=&page=&limit=
router.get('/', (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const q = cleanQueryString(req.query.q);
  const minPrice = parsePriceCents(req.query.min_price);
  const maxPrice = parsePriceCents(req.query.max_price);

  const conditions = ["l.status = 'active'"];
  const params = [];
  if (minPrice != null) { conditions.push('l.price_cents >= ?'); params.push(minPrice); }
  if (maxPrice != null) { conditions.push('l.price_cents <= ?'); params.push(maxPrice); }
  const category = parseCategory(req.query.category);
  if (category) { conditions.push('l.category = ?'); params.push(category); }

  const sortKey = req.query.sort && LISTING_SORTS[req.query.sort] ? req.query.sort : (q ? 'relevance' : 'newest');
  const orderBy = LISTING_SORTS[sortKey] || LISTING_SORTS.newest;

  let rows = [];
  let total = 0;

  if (q && db.ftsAvailable) {
    const ftsQuery = buildFtsMatchQuery(q);
    if (ftsQuery) {
      const extraWhere = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      const orderClause = sortKey === 'relevance' ? 'rank ASC' : orderBy;
      rows = db
        .prepare(
          `SELECT l.*, u.username AS seller_name, u.is_verified AS seller_verified,
            (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS seller_pro, bm25(listings_fts) AS rank
           FROM listings_fts
           JOIN listings l ON l.id = listings_fts.rowid
           JOIN users u ON u.id = l.seller_id
           WHERE listings_fts MATCH ? ${extraWhere}
           ORDER BY ${orderClause}
           LIMIT ? OFFSET ?`
        )
        .all(ftsQuery, ...params, limit, offset);
      total = db
        .prepare(
          `SELECT COUNT(*) c FROM listings_fts
           JOIN listings l ON l.id = listings_fts.rowid
           WHERE listings_fts MATCH ? ${extraWhere}`
        )
        .get(ftsQuery, ...params).c;
    }
  } else if (q) {
    // Fallback when FTS5 isn't available in this SQLite build.
    const likeTerm = `%${escapeLike(q)}%`;
    conditions.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')");
    params.push(likeTerm, likeTerm);
    const where = conditions.join(' AND ');
    rows = db.prepare(`${listingQuery} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    total = db.prepare(`SELECT COUNT(*) c FROM listings l WHERE ${where}`).get(...params).c;
  } else {
    const where = conditions.join(' AND ');
    rows = db.prepare(`${listingQuery} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    total = db.prepare(`SELECT COUNT(*) c FROM listings l WHERE ${where}`).get(...params).c;
  }

  res.json({
    listings: rows,
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
  });
});

router.post('/', requireAuth, (req, res) => {
  const { description, image_url, price_cents } = req.body || {};
  const title = req.body && req.body.title != null ? String(req.body.title).trim() : '';
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  if (title.length > MAX_TITLE_LEN) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE_LEN} characters or fewer.` });
  }
  if (description != null && String(description).length > MAX_DESCRIPTION_LEN) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION_LEN} characters or fewer.` });
  }
  if (price_cents != null && (!Number.isInteger(price_cents) || price_cents <= 0)) {
    return res.status(400).json({ error: 'Price must be a positive amount.' });
  }
  if (!image_url) {
    return res.status(400).json({ error: 'An image of your item is required — upload one or paste a URL.' });
  }
  if (!isValidImageUrl(image_url)) {
    return res.status(400).json({ error: 'Image URL must be a valid http(s) link.' });
  }

  // Content moderation: reject hard-blocked terms, mask mild profanity.
  const modTitle = moderateField(title, 'title');
  if (!modTitle.ok) return res.status(400).json({ error: modTitle.error });
  const modDesc = moderateField(description ? String(description).trim() : null, 'description');
  if (!modDesc.ok) return res.status(400).json({ error: modDesc.error });

  const info = db
    .prepare(
      "INSERT INTO listings (seller_id, title, description, image_url, price_cents, category) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      req.user.id,
      modTitle.clean,
      modDesc.clean || null,
      image_url || null,
      price_cents || null,
      parseCategory(req.body?.category) || 'other'
    );
  const listing = db.prepare(`${listingQuery} WHERE l.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ listing });
});

router.get('/:id', (req, res) => {
  const listing = db.prepare(`${listingQuery} WHERE l.id = ?`).get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found.' });
  listing.watch_count = db
    .prepare("SELECT COUNT(*) c FROM favorites WHERE kind = 'listing' AND item_id = ?")
    .get(listing.id).c;
  // The viewer's live offer on this listing, so the buy modal can show
  // "offer pending" / the accepted discounted price.
  let my_offer = null;
  if (req.user && req.user.id !== listing.seller_id) {
    my_offer = db
      .prepare(
        "SELECT id, amount_cents, counter_cents, status FROM offers WHERE listing_id = ? AND buyer_id = ? AND status IN ('pending','countered','accepted') ORDER BY id DESC LIMIT 1"
      )
      .get(listing.id, req.user.id) || null;
  }
  res.json({ listing, my_offer });
});

// Instant purchase using site credit balance
router.post('/:id/buy-with-credit', requireAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing || listing.status !== 'active') {
    return res.status(400).json({ error: 'This listing is no longer available.' });
  }
  if (!listing.price_cents) {
    return res.status(400).json({ error: 'This item is auction-only.' });
  }
  if (listing.seller_id === req.user.id) {
    return res.status(400).json({ error: "You can't buy your own listing." });
  }
  // An accepted offer overrides the sticker price for this buyer.
  const offer = acceptedOfferFor(listing.id, req.user.id);
  const baseCents = offer ? offer.amount_cents : listing.price_cents;
  const { amountCents, feeCents, sellerProceedsCents } = computeOrderAmounts(baseCents, req.user);
  if (req.user.site_credit_cents < amountCents) {
    return res.status(400).json({ error: `Insufficient site credit — total is ${(amountCents / 100).toFixed(2)} USD including the buyer fee.` });
  }

  // Buyer's credit is deducted now; the seller is paid from ESCROW only after
  // the buyer confirms delivery (see routes/orders.js + lib/fulfillOrder.js).
  let orderId;
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(
      amountCents,
      req.user.id
    );
    db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(listing.id);
    const info = db.prepare(
      `INSERT INTO orders (buyer_id, seller_id, listing_id, amount_cents, fee_cents, seller_proceeds_cents, method, status)
       VALUES (?, ?, ?, ?, ?, ?, 'credit', 'paid')`
    ).run(req.user.id, listing.seller_id, listing.id, amountCents, feeCents, sellerProceedsCents);
    orderId = info.lastInsertRowid;
  });
  tx();
  settleOffersForListing(listing.id, req.user.id);

  notify(
    listing.seller_id,
    'item_sold',
    `"${listing.title}" sold! Payment is held in escrow — deliver the item in Roblox, then mark it delivered.`,
    `#order-${orderId}`
  );

  res.json({ ok: true, order_id: orderId });
});

// Seller edits their own active listing. Lowering the price pings everyone
// who favorited the item.
router.patch('/:id', requireAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing || listing.seller_id !== req.user.id) return res.status(404).json({ error: 'Listing not found.' });
  if (listing.status !== 'active') return res.status(400).json({ error: 'Only active listings can be edited.' });

  const body = req.body || {};
  const updates = {};

  if (body.title != null) {
    const title = String(body.title).trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (title.length > MAX_TITLE_LEN) return res.status(400).json({ error: `Title must be ${MAX_TITLE_LEN} characters or fewer.` });
    const mod = moderateField(title, 'title');
    if (!mod.ok) return res.status(400).json({ error: mod.error });
    updates.title = mod.clean;
  }
  if (body.description !== undefined) {
    const desc = body.description ? String(body.description).trim() : null;
    if (desc && desc.length > MAX_DESCRIPTION_LEN) return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION_LEN} characters or fewer.` });
    const mod = moderateField(desc, 'description');
    if (!mod.ok) return res.status(400).json({ error: mod.error });
    updates.description = mod.clean || null;
  }
  if (body.image_url !== undefined) {
    if (!body.image_url) return res.status(400).json({ error: 'Listings must have an image.' });
    if (!isValidImageUrl(body.image_url)) return res.status(400).json({ error: 'Image URL must be a valid http(s) link.' });
    updates.image_url = body.image_url;
  }
  if (body.price_cents != null) {
    if (!Number.isInteger(body.price_cents) || body.price_cents <= 0) {
      return res.status(400).json({ error: 'Price must be a positive amount.' });
    }
    updates.price_cents = body.price_cents;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });

  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE listings SET ${sets} WHERE id = ?`).run(...Object.values(updates), listing.id);

  if (updates.price_cents && updates.price_cents < listing.price_cents) {
    const watchers = db
      .prepare("SELECT user_id FROM favorites WHERE kind = 'listing' AND item_id = ? AND user_id != ?")
      .all(listing.id, req.user.id);
    for (const w of watchers) {
      notify(
        w.user_id,
        'price_drop',
        `Price drop on "${updates.title || listing.title}": $${(listing.price_cents / 100).toFixed(2)} → $${(updates.price_cents / 100).toFixed(2)}.`,
        `#listing-${listing.id}`
      );
    }
  }

  const updated = db.prepare(`${listingQuery} WHERE l.id = ?`).get(listing.id);
  res.json({ listing: updated });
});

// Seller cancels their own active listing
router.post('/:id/cancel', requireAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing || listing.seller_id !== req.user.id) return res.status(404).json({ error: 'Listing not found.' });
  if (listing.status !== 'active') return res.status(400).json({ error: 'Only active listings can be cancelled.' });
  db.prepare("UPDATE listings SET status = 'removed' WHERE id = ?").run(listing.id);
  res.json({ ok: true });
});

module.exports = router;
