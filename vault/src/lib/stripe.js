const Stripe = require('stripe');
const config = require('../config');

if (!config.stripe.secretKey) {
  console.warn('[stripe] STRIPE_SECRET_KEY not set — card checkout will fail until configured.');
}

const stripe = new Stripe(config.stripe.secretKey || 'sk_test_placeholder', {
  apiVersion: '2024-06-20',
});

/**
 * Creates a Checkout Session for a single order.
 * amountCents is the FULL amount the buyer pays (fee is baked in, not itemized
 * as a separate line so buyers just see one clean price).
 */
async function createCheckoutSession({ orderId, title, amountCents, successUrl, cancelUrl }) {
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: title },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: { order_id: String(orderId) },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

module.exports = { stripe, createCheckoutSession };
