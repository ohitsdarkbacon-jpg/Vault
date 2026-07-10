const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { createCheckoutSession } = require('../lib/stripe');
const { createPayment, getPaymentStatus, FINISHED_STATUSES } = require('../lib/nowpayments');
const { notify } = require('../lib/notify');

const router = express.Router();

const MIN_TOPUP_CENTS = 500;      // $5
const MAX_TOPUP_CENTS = 100000;   // $1,000 per top-up
const VALID_CRYPTOS = new Set(['btc', 'eth', 'usdttrc20', 'usdterc20', 'ltc', 'sol']);

function parseAmount(req, res) {
  const amount = parseInt(req.body?.amount_cents, 10);
  if (!Number.isInteger(amount) || amount < MIN_TOPUP_CENTS || amount > MAX_TOPUP_CENTS) {
    res.status(400).json({
      error: `Top-ups must be between $${(MIN_TOPUP_CENTS / 100).toFixed(2)} and $${(MAX_TOPUP_CENTS / 100).toFixed(0)}.`,
    });
    return null;
  }
  return amount;
}

/**
 * Credits a paid top-up to the user's balance. Idempotent — the pending-only
 * UPDATE means a webhook/polling race credits exactly once.
 */
function fulfillTopup(topupId) {
  const topup = db.prepare('SELECT * FROM topups WHERE id = ?').get(topupId);
  if (!topup || topup.status !== 'pending') return false;
  const info = db.prepare(
    "UPDATE topups SET status = 'paid', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(topup.id);
  if (!info.changes) return false;
  db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(
    topup.amount_cents,
    topup.user_id
  );
  notify(topup.user_id, 'withdrawal', `$${(topup.amount_cents / 100).toFixed(2)} added to your balance. Happy trading!`, '#dashboard');
  console.log(`[topup] #${topup.id} paid — user ${topup.user_id} credited ${topup.amount_cents}c`);
  return true;
}

// ---------- Card top-up (Stripe Checkout) ----------
router.post('/topup/stripe', requireAuth, async (req, res) => {
  const amount = parseAmount(req, res);
  if (amount == null) return;

  const info = db
    .prepare("INSERT INTO topups (user_id, amount_cents, method) VALUES (?, ?, 'stripe')")
    .run(req.user.id, amount);
  const topupId = info.lastInsertRowid;

  try {
    const session = await createCheckoutSession({
      orderId: `topup:${topupId}`,
      title: `Vault balance top-up ($${(amount / 100).toFixed(2)})`,
      amountCents: amount,
      successUrl: `${config.baseUrl}/?topup=success`,
      cancelUrl: `${config.baseUrl}/?topup=cancelled`,
    });
    db.prepare('UPDATE topups SET stripe_session_id = ? WHERE id = ?').run(session.id, topupId);
    res.json({ url: session.url });
  } catch (err) {
    console.error('[topup stripe] error:', err.message);
    res.status(500).json({ error: 'Could not start card payment. Please try again.' });
  }
});

// ---------- Crypto top-up (NOWPayments) ----------
router.post('/topup/crypto', requireAuth, async (req, res) => {
  const amount = parseAmount(req, res);
  if (amount == null) return;
  const payCurrency = String(req.body?.pay_currency || '').toLowerCase();
  if (!VALID_CRYPTOS.has(payCurrency)) return res.status(400).json({ error: 'Unsupported crypto currency.' });

  const info = db
    .prepare("INSERT INTO topups (user_id, amount_cents, method, pay_currency) VALUES (?, ?, 'crypto', ?)")
    .run(req.user.id, amount, payCurrency);
  const topupId = info.lastInsertRowid;

  try {
    const payment = await createPayment({
      orderId: `topup:${topupId}`,
      amountUsd: amount / 100,
      payCurrency,
      ipnCallbackUrl: `${config.baseUrl}/webhooks/nowpayments`,
    });
    db.prepare('UPDATE topups SET nowpayments_payment_id = ? WHERE id = ?').run(String(payment.payment_id), topupId);
    res.json({
      topup_id: topupId,
      pay_address: payment.pay_address,
      pay_amount: payment.pay_amount,
      pay_currency: payment.pay_currency,
    });
  } catch (err) {
    console.error('[topup crypto] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start crypto payment. Please try again.' });
  }
});

// ---------- Status poll (drives the crypto modal; also fulfills without IPN) ----------
const statusCache = new Map(); // topup_id -> { at, data }
const STATUS_TTL_MS = 15 * 1000;

router.get('/topup/:id', requireAuth, async (req, res) => {
  const topup = db.prepare('SELECT * FROM topups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!topup) return res.status(404).json({ error: 'Top-up not found.' });

  let payment = null;
  if (topup.status === 'pending' && topup.nowpayments_payment_id) {
    const hit = statusCache.get(topup.id);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) {
      payment = hit.data;
    } else {
      try {
        const s = await getPaymentStatus(topup.nowpayments_payment_id);
        payment = {
          status: s.payment_status,
          pay_amount: s.pay_amount,
          actually_paid: s.actually_paid,
          pay_currency: s.pay_currency,
        };
        statusCache.set(topup.id, { at: Date.now(), data: payment });
      } catch (_) { /* API hiccup — status alone still renders */ }
    }
    if (payment && FINISHED_STATUSES.has(payment.status)) {
      fulfillTopup(topup.id);
      topup.status = 'paid';
    } else if (payment && ['failed', 'expired', 'refunded'].includes(payment.status)) {
      db.prepare("UPDATE topups SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(topup.id);
      topup.status = 'failed';
    }
  }
  res.json({ status: topup.status, amount_cents: topup.amount_cents, payment });
});

module.exports = { router, fulfillTopup };
