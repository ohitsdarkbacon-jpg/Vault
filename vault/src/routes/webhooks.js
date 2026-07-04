const express = require('express');
const db = require('../db');
const config = require('../config');
const { stripe } = require('../lib/stripe');
const { verifyIpnSignature, FINISHED_STATUSES } = require('../lib/nowpayments');
const { isPayoutIpn, handlePayoutIpn } = require('../lib/payouts');
const { fulfillOrder } = require('../lib/fulfillOrder');
const { notify, notifyAdmins } = require('../lib/notify');

const router = express.Router();

// IMPORTANT: the Stripe webhook needs the exact raw request bytes to verify
// its signature. It is wired up directly in src/index.js with express.raw()
// BEFORE the global express.json() middleware runs, using this handler.
function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    if (orderId && session.payment_status === 'paid') {
      fulfillOrder(Number(orderId));
    }
  }

  res.json({ received: true });
}

// NOWPayments IPN — regular JSON body, verified via HMAC header instead of raw-body
// signing. This router is mounted AFTER the global express.json() in src/index.js.
router.post('/nowpayments', (req, res) => {
  const sig = req.headers['x-nowpayments-sig'];
  const valid = verifyIpnSignature(req.body, sig);
  if (!valid) {
    console.error('[nowpayments webhook] invalid signature');
    return res.status(400).json({ error: 'invalid signature' });
  }

  // ---- Payout IPNs (automated withdrawals) are handled by the shared helper ----
  if (isPayoutIpn(req.body)) {
    handlePayoutIpn(req.body);
    return res.json({ received: true });
  }

  const { payment_id, payment_status, order_id } = req.body;
  db.prepare(
    "UPDATE orders SET updated_at = datetime('now') WHERE nowpayments_payment_id = ?"
  ).run(String(payment_id));

  if (FINISHED_STATUSES.has(payment_status)) {
    const orderId = order_id ? Number(order_id) : null;
    const order = orderId
      ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
      : db.prepare('SELECT * FROM orders WHERE nowpayments_payment_id = ?').get(String(payment_id));
    if (order) fulfillOrder(order.id);
  } else if (['failed', 'expired', 'refunded'].includes(payment_status)) {
    // Only a still-pending order may be failed. Without the status guard a
    // late/out-of-order IPN (chain reorg, refund event) could flip an order
    // that already fulfilled into escrow back to 'failed'.
    db.prepare(
      "UPDATE orders SET status = 'failed', updated_at = datetime('now') WHERE nowpayments_payment_id = ? AND status = 'pending'"
    ).run(String(payment_id));
  } else if (payment_status === 'partially_paid') {
    // Buyer sent less than the invoice amount. The order stays pending (the
    // live-status endpoint shows the shortfall to the buyer); flag admins so
    // it can be resolved manually — NOWPayments won't auto-complete it.
    const order = db.prepare('SELECT * FROM orders WHERE nowpayments_payment_id = ?').get(String(payment_id));
    if (order && order.status === 'pending') {
      notifyAdmins(
        'admin',
        `Order #${order.id} was PARTIALLY paid (crypto). Buyer sent ${req.body.actually_paid ?? '?'} of ${req.body.pay_amount ?? '?'} ${String(req.body.pay_currency || '').toUpperCase()} — resolve manually in NOWPayments.`,
        '#admin'
      );
    }
  }

  res.json({ received: true });
});

module.exports = { router, stripeWebhookHandler };
