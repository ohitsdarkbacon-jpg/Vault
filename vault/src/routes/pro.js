const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { createPayment, getPaymentStatus, FINISHED_STATUSES } = require('../lib/nowpayments');
const { isPro } = require('../lib/fees');
const { notify } = require('../lib/notify');

const router = express.Router();

const VALID_CRYPTOS = new Set(['btc', 'eth', 'usdttrc20', 'usdterc20', 'ltc', 'sol']);

// Extend the member's paid-through date by one period, from whichever is
// later: now, or their current expiry (so renewing early never loses days).
function extendPro(userId) {
  const u = db.prepare('SELECT pro_until FROM users WHERE id = ?').get(userId);
  const base = u && u.pro_until && Date.parse(u.pro_until) > Date.now() ? Date.parse(u.pro_until) : Date.now();
  const until = new Date(base + config.proDays * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET pro_until = ? WHERE id = ?').run(until, userId);
  return until;
}

/**
 * Marks a paid Pro purchase fulfilled and extends the subscription.
 * Idempotent — the pending-only UPDATE means a webhook/polling race
 * extends exactly once.
 */
function fulfillProPurchase(purchaseId) {
  const p = db.prepare('SELECT * FROM pro_purchases WHERE id = ?').get(purchaseId);
  if (!p || p.status !== 'pending') return false;
  const info = db.prepare(
    "UPDATE pro_purchases SET status = 'paid', updated_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).run(p.id);
  if (!info.changes) return false;
  const until = extendPro(p.user_id);
  notify(p.user_id, 'admin', `⭐ Welcome to Vault Pro! Your reduced ${(config.proFeeBps / 100).toFixed(1)}% buyer fee and perks are active until ${until.slice(0, 10)}.`, '#dashboard');
  console.log(`[pro] purchase #${p.id} paid — user ${p.user_id} pro until ${until}`);
  return true;
}

// ---------- Status ----------
router.get('/pro', requireAuth, (req, res) => {
  const pending = db
    .prepare("SELECT id FROM pro_purchases WHERE user_id = ? AND status = 'pending' AND method = 'crypto' ORDER BY id DESC LIMIT 1")
    .get(req.user.id);
  res.json({
    active: isPro(req.user),
    until: req.user.pro_until || null,
    auto_renew: !!req.user.pro_auto_renew,
    price_cents: config.proPriceCents,
    fee_bps: config.platformFeeBps,
    pro_fee_bps: config.proFeeBps,
    days: config.proDays,
    pending_purchase_id: pending ? pending.id : null,
  });
});

// ---------- Subscribe ----------
router.post('/pro/subscribe', requireAuth, async (req, res) => {
  const method = String(req.body?.method || 'crypto');

  if (method === 'balance') {
    if (req.user.site_credit_cents < config.proPriceCents) {
      return res.status(400).json({ error: `You need ${(config.proPriceCents / 100).toFixed(2)} USD of site credit — add funds first or pay with crypto.` });
    }
    let until;
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(config.proPriceCents, req.user.id);
      db.prepare("INSERT INTO pro_purchases (user_id, amount_cents, method, status) VALUES (?, ?, 'balance', 'paid')").run(req.user.id, config.proPriceCents);
      until = extendPro(req.user.id);
    });
    tx();
    notify(req.user.id, 'admin', `⭐ Welcome to Vault Pro! Your reduced ${(config.proFeeBps / 100).toFixed(1)}% buyer fee and perks are active until ${until.slice(0, 10)}.`, '#dashboard');
    return res.json({ ok: true, active: true, until });
  }

  if (method !== 'crypto') return res.status(400).json({ error: 'Pay with crypto or your site balance.' });
  const payCurrency = String(req.body?.pay_currency || '').toLowerCase();
  if (!VALID_CRYPTOS.has(payCurrency)) return res.status(400).json({ error: 'Unsupported crypto currency.' });

  const info = db
    .prepare("INSERT INTO pro_purchases (user_id, amount_cents, method, pay_currency) VALUES (?, ?, 'crypto', ?)")
    .run(req.user.id, config.proPriceCents, payCurrency);
  const purchaseId = info.lastInsertRowid;

  try {
    const payment = await createPayment({
      orderId: `pro:${purchaseId}`,
      amountUsd: config.proPriceCents / 100,
      payCurrency,
      ipnCallbackUrl: `${config.baseUrl}/webhooks/nowpayments`,
    });
    db.prepare('UPDATE pro_purchases SET nowpayments_payment_id = ? WHERE id = ?').run(String(payment.payment_id), purchaseId);
    res.json({
      pro_purchase_id: purchaseId,
      pay_address: payment.pay_address,
      pay_amount: payment.pay_amount,
      pay_currency: payment.pay_currency,
    });
  } catch (err) {
    console.error('[pro crypto] error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start crypto payment. Please try again.' });
  }
});

// ---------- Auto-renew toggle (renews from site balance) ----------
router.post('/pro/auto-renew', requireAuth, (req, res) => {
  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare('UPDATE users SET pro_auto_renew = ? WHERE id = ?').run(enabled, req.user.id);
  res.json({ ok: true, auto_renew: !!enabled });
});

// ---------- Status poll (drives the crypto modal; also fulfills without IPN) ----------
const statusCache = new Map(); // purchase_id -> { at, data }
const STATUS_TTL_MS = 15 * 1000;

router.get('/pro/purchases/:id', requireAuth, async (req, res) => {
  const p = db.prepare('SELECT * FROM pro_purchases WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!p) return res.status(404).json({ error: 'Purchase not found.' });

  let payment = null;
  if (p.status === 'pending' && p.nowpayments_payment_id) {
    const hit = statusCache.get(p.id);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) {
      payment = hit.data;
    } else {
      try {
        const s = await getPaymentStatus(p.nowpayments_payment_id);
        payment = {
          status: s.payment_status,
          pay_amount: s.pay_amount,
          actually_paid: s.actually_paid,
          pay_currency: s.pay_currency,
        };
        statusCache.set(p.id, { at: Date.now(), data: payment });
      } catch (_) { /* API hiccup — status alone still renders */ }
    }
    if (payment && FINISHED_STATUSES.has(payment.status)) {
      fulfillProPurchase(p.id);
      p.status = 'paid';
    } else if (payment && ['failed', 'expired', 'refunded'].includes(payment.status)) {
      db.prepare("UPDATE pro_purchases SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(p.id);
      p.status = 'failed';
    }
  }
  res.json({ status: p.status, amount_cents: p.amount_cents, payment });
});

// ---------- Auto-renew job ----------
// Members with auto-renew on are renewed from their site balance when their
// period lapses. Can't afford it -> auto-renew flips off with a heads-up, so
// we never retry-spam an empty wallet.
function processProRenewals() {
  const due = db
    .prepare(
      `SELECT id, site_credit_cents FROM users
       WHERE pro_auto_renew = 1 AND pro_until IS NOT NULL
         AND julianday(pro_until) <= julianday('now')`
    )
    .all();
  for (const u of due) {
    if (u.site_credit_cents >= config.proPriceCents) {
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(config.proPriceCents, u.id);
        db.prepare("INSERT INTO pro_purchases (user_id, amount_cents, method, status) VALUES (?, ?, 'balance', 'paid')").run(u.id, config.proPriceCents);
        extendPro(u.id);
      });
      tx();
      notify(u.id, 'admin', `⭐ Vault Pro renewed for ${(config.proPriceCents / 100).toFixed(2)} USD from your balance. Thanks for being Pro!`, '#dashboard');
    } else {
      db.prepare('UPDATE users SET pro_auto_renew = 0 WHERE id = ?').run(u.id);
      notify(u.id, 'admin', '⭐ Your Vault Pro lapsed — there wasn\'t enough site credit to auto-renew. Resubscribe any time from your menu.', '#dashboard');
    }
  }
}

let renewTimer = null;
function startProRenewJob() {
  if (renewTimer) return;
  processProRenewals();
  renewTimer = setInterval(processProRenewals, 60 * 60 * 1000);
}

module.exports = { router, fulfillProPurchase, startProRenewJob, processProRenewals };
