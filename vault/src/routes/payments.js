const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { computeOrderAmounts } = require('../lib/fees');
const { createCheckoutSession } = require('../lib/stripe');
const { createPayment } = require('../lib/nowpayments');
const { acceptedOfferFor } = require('../lib/fulfillOrder');

const router = express.Router();

const VALID_CRYPTOS = new Set(['btc', 'eth', 'usdttrc20', 'usdterc20', 'ltc', 'sol']);

function loadAuctionForCheckout(req) {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return { error: [404, 'Auction not found.'] };
  if (auction.status !== 'ended' && new Date(auction.ends_at) > new Date()) {
    return { error: [400, 'This auction has not ended yet.'] };
  }
  if (auction.status === 'live') {
    // lazily flip to ended if the closer job hasn't run yet
    db.prepare("UPDATE auctions SET status = 'ended', winner_id = current_bidder_id WHERE id = ?").run(
      auction.id
    );
    auction.status = 'ended';
    auction.winner_id = auction.current_bidder_id;
  }
  if (auction.status === 'paid') return { error: [400, 'This auction has already been paid for.'] };
  if (!auction.winner_id || auction.winner_id !== req.user.id) {
    return { error: [403, 'Only the winning bidder can check out this auction.'] };
  }
  return { auction };
}

function loadListingForCheckout(req) {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return { error: [404, 'Listing not found.'] };
  if (listing.status !== 'active') return { error: [400, 'This listing is no longer available.'] };
  if (!listing.price_cents) return { error: [400, 'This item is auction-only.'] };
  if (listing.seller_id === req.user.id) return { error: [400, "You can't buy your own listing."] };
  // An accepted offer overrides the sticker price for this buyer.
  const offer = acceptedOfferFor(listing.id, req.user.id);
  return { listing, baseCents: offer ? offer.amount_cents : listing.price_cents };
}

// baseCents = the listing price / winning bid. In 'added' fee mode the buyer
// is charged base + fee and the seller's escrowed proceeds equal the full base.
function createPendingOrder({ buyerId, sellerId, listingId, auctionId, baseCents, method }) {
  const { amountCents, feeCents, sellerProceedsCents } = computeOrderAmounts(baseCents);
  const info = db
    .prepare(
      `INSERT INTO orders (buyer_id, seller_id, listing_id, auction_id, amount_cents, fee_cents, seller_proceeds_cents, method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(buyerId, sellerId, listingId || null, auctionId || null, amountCents, feeCents, sellerProceedsCents, method);
  return { orderId: info.lastInsertRowid, amountCents };
}

// ---------- Auction checkout ----------

router.post('/auctions/:id/checkout/stripe', requireAuth, async (req, res) => {
  const { auction, error } = loadAuctionForCheckout(req);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const baseCents = auction.current_bid_cents || auction.starting_bid_cents;
  const { orderId, amountCents } = createPendingOrder({
    buyerId: req.user.id,
    sellerId: auction.seller_id,
    auctionId: auction.id,
    baseCents,
    method: 'stripe',
  });

  try {
    const session = await createCheckoutSession({
      orderId,
      title: `Auction: ${auction.title}`,
      amountCents,
      successUrl: `${config.baseUrl}/?checkout=success&order=${orderId}`,
      cancelUrl: `${config.baseUrl}/?checkout=cancelled&order=${orderId}`,
    });
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
    res.json({ url: session.url, order_id: orderId });
  } catch (err) {
    console.error('[stripe] checkout session error:', err.message);
    res.status(500).json({ error: 'Could not start card checkout. Please try again.' });
  }
});

router.post('/auctions/:id/checkout/crypto', requireAuth, async (req, res) => {
  const { auction, error } = loadAuctionForCheckout(req);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const payCurrency = String(req.body?.pay_currency || '').toLowerCase();
  if (!VALID_CRYPTOS.has(payCurrency)) {
    return res.status(400).json({ error: 'Unsupported crypto currency.' });
  }

  const baseCents = auction.current_bid_cents || auction.starting_bid_cents;
  const { orderId, amountCents } = createPendingOrder({
    buyerId: req.user.id,
    sellerId: auction.seller_id,
    auctionId: auction.id,
    baseCents,
    method: 'crypto',
  });

  try {
    const payment = await createPayment({
      orderId,
      amountUsd: amountCents / 100,
      payCurrency,
      ipnCallbackUrl: `${config.baseUrl}/webhooks/nowpayments`,
    });
    db.prepare(
      'UPDATE orders SET nowpayments_payment_id = ?, pay_currency = ? WHERE id = ?'
    ).run(String(payment.payment_id), payCurrency, orderId);
    res.json({
      order_id: orderId,
      payment_id: payment.payment_id,
      pay_address: payment.pay_address,
      pay_amount: payment.pay_amount,
      pay_currency: payment.pay_currency,
    });
  } catch (err) {
    console.error('[nowpayments] create payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start crypto checkout. Please try again.' });
  }
});

// ---------- Fixed-price listing checkout (card / crypto) ----------

router.post('/listings/:id/checkout/stripe', requireAuth, async (req, res) => {
  const { listing, baseCents, error } = loadListingForCheckout(req);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const { orderId, amountCents } = createPendingOrder({
    buyerId: req.user.id,
    sellerId: listing.seller_id,
    listingId: listing.id,
    baseCents,
    method: 'stripe',
  });

  try {
    const session = await createCheckoutSession({
      orderId,
      title: listing.title,
      amountCents,
      successUrl: `${config.baseUrl}/?checkout=success&order=${orderId}`,
      cancelUrl: `${config.baseUrl}/?checkout=cancelled&order=${orderId}`,
    });
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
    res.json({ url: session.url, order_id: orderId });
  } catch (err) {
    console.error('[stripe] checkout session error:', err.message);
    res.status(500).json({ error: 'Could not start card checkout. Please try again.' });
  }
});

router.post('/listings/:id/checkout/crypto', requireAuth, async (req, res) => {
  const { listing, baseCents, error } = loadListingForCheckout(req);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const payCurrency = String(req.body?.pay_currency || '').toLowerCase();
  if (!VALID_CRYPTOS.has(payCurrency)) {
    return res.status(400).json({ error: 'Unsupported crypto currency.' });
  }

  const { orderId, amountCents } = createPendingOrder({
    buyerId: req.user.id,
    sellerId: listing.seller_id,
    listingId: listing.id,
    baseCents,
    method: 'crypto',
  });

  try {
    const payment = await createPayment({
      orderId,
      amountUsd: amountCents / 100,
      payCurrency,
      ipnCallbackUrl: `${config.baseUrl}/webhooks/nowpayments`,
    });
    db.prepare(
      'UPDATE orders SET nowpayments_payment_id = ?, pay_currency = ? WHERE id = ?'
    ).run(String(payment.payment_id), payCurrency, orderId);
    res.json({
      order_id: orderId,
      payment_id: payment.payment_id,
      pay_address: payment.pay_address,
      pay_amount: payment.pay_amount,
      pay_currency: payment.pay_currency,
    });
  } catch (err) {
    console.error('[nowpayments] create payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start crypto checkout. Please try again.' });
  }
});

// NOTE: GET /api/orders/:id (status polling) now lives in routes/orders.js
// together with the rest of the order lifecycle.

module.exports = router;
