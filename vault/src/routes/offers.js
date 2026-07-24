const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../lib/notify');

const router = express.Router();

const MIN_OFFER_CENTS = 100; // $1

function money(cents) { return `$${(cents / 100).toFixed(2)}`; }

// ---------- Make an offer on a fixed-price listing ----------
router.post('/listings/:id/offers', requireAuth, (req, res) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing || listing.status !== 'active') return res.status(400).json({ error: 'This listing is no longer available.' });
  if (listing.expires_at && Date.parse(listing.expires_at + 'Z') <= Date.now()) {
    return res.status(400).json({ error: 'This flash listing has expired.' });
  }
  if (!listing.price_cents) return res.status(400).json({ error: 'This item is auction-only.' });
  if (listing.seller_id === req.user.id) return res.status(400).json({ error: "You can't make an offer on your own listing." });

  const amount = parseInt(req.body?.amount_cents, 10);
  if (!Number.isInteger(amount) || amount < MIN_OFFER_CENTS) {
    return res.status(400).json({ error: `Offers start at ${money(MIN_OFFER_CENTS)}.` });
  }
  if (amount >= listing.price_cents) {
    return res.status(400).json({ error: 'Your offer is at or above the asking price — just buy it!' });
  }

  const live = db
    .prepare("SELECT 1 FROM offers WHERE listing_id = ? AND buyer_id = ? AND status IN ('pending','countered','accepted')")
    .get(listing.id, req.user.id);
  if (live) return res.status(400).json({ error: 'You already have an active offer on this item.' });

  const info = db
    .prepare('INSERT INTO offers (listing_id, buyer_id, amount_cents) VALUES (?, ?, ?)')
    .run(listing.id, req.user.id, amount);

  notify(
    listing.seller_id,
    'offer',
    `${req.user.username} offered ${money(amount)} for "${listing.title}" (asking ${money(listing.price_cents)}). Review it in your dashboard.`,
    '#dashboard'
  );
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// ---------- My offers (both directions) ----------
router.get('/my/offers', requireAuth, (req, res) => {
  const sent = db
    .prepare(
      `SELECT o.*, l.title, l.image_url, l.price_cents, l.status AS listing_status, u.username AS seller_name
       FROM offers o JOIN listings l ON l.id = o.listing_id JOIN users u ON u.id = l.seller_id
       WHERE o.buyer_id = ? ORDER BY o.updated_at DESC LIMIT 50`
    )
    .all(req.user.id);
  const received = db
    .prepare(
      `SELECT o.*, l.title, l.image_url, l.price_cents, l.status AS listing_status, u.username AS buyer_name
       FROM offers o JOIN listings l ON l.id = o.listing_id JOIN users u ON u.id = o.buyer_id
       WHERE l.seller_id = ? ORDER BY o.updated_at DESC LIMIT 50`
    )
    .all(req.user.id);
  res.json({ sent, received });
});

function loadOffer(req, res) {
  const offer = db
    .prepare(
      `SELECT o.*, l.seller_id, l.title, l.status AS listing_status, l.price_cents
       FROM offers o JOIN listings l ON l.id = o.listing_id WHERE o.id = ?`
    )
    .get(req.params.id);
  if (!offer) { res.status(404).json({ error: 'Offer not found.' }); return null; }
  return offer;
}

function setStatus(id, status, counterCents) {
  db.prepare(
    "UPDATE offers SET status = ?, counter_cents = COALESCE(?, counter_cents), updated_at = datetime('now') WHERE id = ?"
  ).run(status, counterCents ?? null, id);
}

// ---------- Accept ----------
// pending  → the SELLER accepts the buyer's amount
// countered → the BUYER accepts the seller's counter (final price = counter)
router.post('/offers/:id/accept', requireAuth, (req, res) => {
  const offer = loadOffer(req, res);
  if (!offer) return;
  if (offer.listing_status !== 'active') return res.status(400).json({ error: 'This listing is no longer available.' });

  if (offer.status === 'pending') {
    if (offer.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can accept this offer.' });
    setStatus(offer.id, 'accepted');
    notify(
      offer.buyer_id,
      'offer',
      `Your ${money(offer.amount_cents)} offer on "${offer.title}" was accepted! Complete checkout before someone else buys it.`,
      '#dashboard'
    );
    return res.json({ ok: true, price_cents: offer.amount_cents });
  }
  if (offer.status === 'countered') {
    if (offer.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can accept the counter-offer.' });
    db.prepare(
      "UPDATE offers SET status = 'accepted', amount_cents = counter_cents, updated_at = datetime('now') WHERE id = ?"
    ).run(offer.id);
    notify(
      offer.seller_id,
      'offer',
      `${req.user.username} accepted your ${money(offer.counter_cents)} counter on "${offer.title}" — waiting for them to check out.`,
      '#dashboard'
    );
    return res.json({ ok: true, price_cents: offer.counter_cents });
  }
  res.status(400).json({ error: `This offer is ${offer.status} and can't be accepted.` });
});

// ---------- Decline (seller, on pending or countered) ----------
router.post('/offers/:id/decline', requireAuth, (req, res) => {
  const offer = loadOffer(req, res);
  if (!offer) return;
  if (offer.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can decline an offer.' });
  if (!['pending', 'countered'].includes(offer.status)) {
    return res.status(400).json({ error: `This offer is ${offer.status} and can't be declined.` });
  }
  setStatus(offer.id, 'declined');
  notify(offer.buyer_id, 'offer', `Your offer on "${offer.title}" was declined.`, '#listings');
  res.json({ ok: true });
});

// ---------- Counter (seller, on pending) ----------
router.post('/offers/:id/counter', requireAuth, (req, res) => {
  const offer = loadOffer(req, res);
  if (!offer) return;
  if (offer.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can counter an offer.' });
  if (offer.status !== 'pending') return res.status(400).json({ error: `This offer is ${offer.status} and can't be countered.` });

  const amount = parseInt(req.body?.amount_cents, 10);
  if (!Number.isInteger(amount) || amount <= offer.amount_cents) {
    return res.status(400).json({ error: 'Counter must be higher than their offer.' });
  }
  if (amount > offer.price_cents) {
    return res.status(400).json({ error: "Counter can't exceed your asking price." });
  }
  setStatus(offer.id, 'countered', amount);
  notify(
    offer.buyer_id,
    'offer',
    `The seller countered your offer on "${offer.title}": ${money(amount)} (you offered ${money(offer.amount_cents)}). Accept it in your dashboard.`,
    '#dashboard'
  );
  res.json({ ok: true });
});

// ---------- Withdraw (buyer, on pending/countered/accepted) ----------
router.post('/offers/:id/withdraw', requireAuth, (req, res) => {
  const offer = loadOffer(req, res);
  if (!offer) return;
  if (offer.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can withdraw an offer.' });
  if (!['pending', 'countered', 'accepted'].includes(offer.status)) {
    return res.status(400).json({ error: `This offer is ${offer.status} and can't be withdrawn.` });
  }
  setStatus(offer.id, 'withdrawn');
  res.json({ ok: true });
});

module.exports = router;
