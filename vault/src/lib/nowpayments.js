const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

const client = axios.create({
  baseURL: config.nowpayments.apiBase,
  headers: { 'x-api-key': config.nowpayments.apiKey || '' },
});

/**
 * Creates a crypto payment for an order.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt (NOWPayments API)
 */
async function createPayment({ orderId, amountUsd, payCurrency, ipnCallbackUrl }) {
  const { data } = await client.post('/payment', {
    price_amount: amountUsd,
    price_currency: 'usd',
    pay_currency: payCurrency, // e.g. 'btc', 'eth', 'usdttrc20'
    order_id: String(orderId),
    ipn_callback_url: ipnCallbackUrl,
  });
  return data; // { payment_id, pay_address, pay_amount, pay_currency, payment_status, ... }
}

async function getPaymentStatus(paymentId) {
  const { data } = await client.get(`/payment/${paymentId}`);
  return data;
}

/**
 * Verifies the x-nowpayments-sig header on an IPN callback.
 * NOWPayments signs a JSON-stringified copy of the body with keys sorted
 * alphabetically, using HMAC-SHA512 with your IPN secret.
 */
function verifyIpnSignature(rawBodyObject, signatureHeader) {
  if (!config.nowpayments.ipnSecret || !signatureHeader) return false;
  const sorted = Object.keys(rawBodyObject)
    .sort()
    .reduce((acc, k) => {
      acc[k] = rawBodyObject[k];
      return acc;
    }, {});
  const hmac = crypto
    .createHmac('sha512', config.nowpayments.ipnSecret)
    .update(JSON.stringify(sorted))
    .digest('hex');
  return hmac === signatureHeader;
}

// Statuses NOWPayments considers "money received / done"
const FINISHED_STATUSES = new Set(['finished', 'confirmed']);

// ---------------- Automated payouts (Mass Payouts API) ----------------
// Requires account email + password (JWT auth) and, if 2FA is enabled on the
// account (it should be), the 2FA secret so we can generate the code server-side.
// Enable by setting NOWPAYMENTS_EMAIL / NOWPAYMENTS_PASSWORD / NOWPAYMENTS_2FA_SECRET.

const { totp } = require('./totp');

function payoutsEnabled() {
  return Boolean(config.nowpayments.apiKey && config.nowpayments.email && config.nowpayments.password);
}

// JWT tokens are short-lived; fetch a fresh one per payout batch.
async function getAuthToken() {
  const { data } = await client.post('/auth', {
    email: config.nowpayments.email,
    password: config.nowpayments.password,
  });
  if (!data || !data.token) throw new Error('NOWPayments auth did not return a token');
  return data.token;
}

/**
 * Creates a payout batch (one withdrawal) and, if a 2FA secret is configured,
 * verifies it immediately with a generated TOTP code.
 * Returns { batchId, withdrawalId, status }.
 */
async function createPayout({ address, currency, amountUsd, ipnCallbackUrl }) {
  const token = await getAuthToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const { data: batch } = await client.post(
    '/payout',
    {
      ipn_callback_url: ipnCallbackUrl,
      withdrawals: [
        {
          address,
          currency,                    // payout coin, e.g. 'usdttrc20'
          fiat_amount: amountUsd,      // we owe USD; NOWPayments converts
          fiat_currency: 'usd',
          ipn_callback_url: ipnCallbackUrl,
        },
      ],
    },
    { headers: authHeaders }
  );

  const batchId = String(batch.id);
  const w = Array.isArray(batch.withdrawals) ? batch.withdrawals[0] : null;

  if (config.nowpayments.twoFaSecret) {
    await client.post(
      `/payout/${batchId}/verify`,
      { verification_code: totp(config.nowpayments.twoFaSecret) },
      { headers: authHeaders }
    );
  }

  return {
    batchId,
    withdrawalId: w ? String(w.id) : null,
    status: w ? w.status : 'creating',
  };
}

// Payout withdrawal statuses that mean "money left our balance successfully"
const PAYOUT_FINISHED = new Set(['finished']);
const PAYOUT_FAILED = new Set(['failed', 'rejected']);

module.exports = {
  createPayment,
  getPaymentStatus,
  verifyIpnSignature,
  FINISHED_STATUSES,
  payoutsEnabled,
  createPayout,
  PAYOUT_FINISHED,
  PAYOUT_FAILED,
};
