const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

const client = axios.create({
  baseURL: config.nowpayments.apiBase,
  headers: { 'x-api-key': config.nowpayments.apiKey || '' },
});

// NOWPayments rejects the whole request ("ipn_callback_url must be a valid
// uri") if the callback isn't a public http(s) URL — which is exactly what it
// gets when BASE_URL is unset (localhost) or a LAN address. In that case we
// omit the field entirely: the payment still works, and order fulfillment
// falls back to status polling (see routes/orders.js).
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
let warnedNoIpn = false;

function validIpnUrl(url) {
  try {
    const u = new URL(url);
    const ok = /^https?:$/.test(u.protocol) && !PRIVATE_HOST.test(u.hostname) && u.hostname.includes('.');
    if (ok) return url;
  } catch (_) { /* fall through */ }
  if (!warnedNoIpn) {
    warnedNoIpn = true;
    console.warn(
      `[nowpayments] BASE_URL (${config.baseUrl}) is not publicly reachable — ` +
      'sending payments without an IPN callback. Orders will confirm via status ' +
      'polling instead. Set BASE_URL to your public https:// URL to enable webhooks.'
    );
  }
  return null;
}

/**
 * Creates a crypto payment for an order.
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt (NOWPayments API)
 */
async function createPayment({ orderId, amountUsd, payCurrency, ipnCallbackUrl }) {
  const body = {
    price_amount: amountUsd,
    price_currency: 'usd',
    pay_currency: payCurrency, // e.g. 'btc', 'eth', 'usdttrc20'
    order_id: String(orderId),
  };
  const ipn = validIpnUrl(ipnCallbackUrl);
  if (ipn) body.ipn_callback_url = ipn;
  const { data } = await client.post('/payment', body);
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

  const ipn = validIpnUrl(ipnCallbackUrl);
  const withdrawal = {
    address,
    currency,                    // payout coin, e.g. 'usdttrc20'
    fiat_amount: amountUsd,      // we owe USD; NOWPayments converts
    fiat_currency: 'usd',
  };
  if (ipn) withdrawal.ipn_callback_url = ipn;

  const { data: batch } = await client.post(
    '/payout',
    { ...(ipn ? { ipn_callback_url: ipn } : {}), withdrawals: [withdrawal] },
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
  validIpnUrl,
  FINISHED_STATUSES,
  payoutsEnabled,
  createPayout,
  PAYOUT_FINISHED,
  PAYOUT_FAILED,
};
