/**
 * Local test suite for the automatic crypto payout system.
 *
 * The NOWPayments network calls (createPayout) are MOCKED via a module stub so
 * we can deterministically drive success and failure without real credentials
 * or a funded balance. Everything else is the real code: the risk-cap decision,
 * the DB writes, the daily-cap accounting, the webhook handler, the fee math,
 * and the real TOTP generator.
 *
 * Run: node test/payouts.test.js
 */
const path = require('path');
const assert = require('assert');

// --- force a clean, isolated DB and known config BEFORE requiring app modules ---
process.env.DB_PATH = path.join(__dirname, 'test-payouts.db');
process.env.AUTO_PAYOUT = '1';
process.env.AUTO_PAYOUT_MAX_CENTS = '20000';       // $200 per withdrawal
process.env.AUTO_PAYOUT_DAILY_CAP_CENTS = '50000'; // $500 / user / 24h
process.env.MIN_WITHDRAWAL_CENTS = '500';
process.env.SESSION_SECRET = 'test-secret';
process.env.BASE_URL = 'http://localhost:3000';
process.env.FEE_MODE = 'added';
process.env.PLATFORM_FEE_BPS = '600';
// Payout creds present so payoutsEnabled() is true (values are dummy; call is mocked)
process.env.NOWPAYMENTS_API_KEY = 'test-key';
process.env.NOWPAYMENTS_EMAIL = 'test@example.com';
process.env.NOWPAYMENTS_PASSWORD = 'pw';
process.env.NOWPAYMENTS_2FA_SECRET = 'JBSWY3DPEHPK3PXP';

require('fs').rmSync(process.env.DB_PATH, { force: true });

// --- Mock the NOWPayments module (intercept createPayout) ---
const nowpaymentsPath = require.resolve('../src/lib/nowpayments');
const realNp = require('../src/lib/nowpayments');
let mockMode = 'success';       // 'success' | 'fail'
let payoutCalls = [];
let globalPayoutSeq = 0;        // unique across ALL tests (row-id lookups must not collide)
realNp.createPayout = async (args) => {
  payoutCalls.push(args);
  if (mockMode === 'fail') {
    const err = new Error('mock network failure');
    err.response = { data: { message: 'insufficient balance' } };
    throw err;
  }
  globalPayoutSeq += 1;
  return { batchId: 'batch_' + globalPayoutSeq, withdrawalId: 'wd_' + globalPayoutSeq, status: 'processing' };
};
require.cache[nowpaymentsPath].exports = realNp;

const db = require('../src/db');
const config = require('../src/config');
const { maybeAutoPayout, evaluateAutoPayout } = require('../src/lib/payouts');
const { computeOrderAmounts } = require('../src/lib/fees');
const { totp } = require('../src/lib/totp');

// --- helpers ---
let userSeq = 0;
function makeUser(balanceCents) {
  userSeq += 1;
  const info = db
    .prepare('INSERT INTO users (provider_id, username, site_credit_cents) VALUES (?, ?, ?)')
    .run('rbx_' + userSeq, 'user' + userSeq, balanceCents);
  return info.lastInsertRowid;
}
function requestWithdrawal(userId, amountCents, { method = 'crypto', currency = 'usdttrc20', destination = 'TXtest' } = {}) {
  // Mirrors what the route does: deduct balance, insert row, then evaluate.
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents - ? WHERE id = ?').run(amountCents, userId);
    db.prepare(
      'INSERT INTO withdrawals (user_id, amount_cents, method, destination, currency) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, amountCents, method, destination, method === 'crypto' ? currency : null);
  });
  tx();
  return db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
}

let passed = 0;
async function test(name, fn) {
  payoutCalls = [];
  mockMode = 'success';
  try {
    await fn();
    console.log('  \u2713', name);
    passed += 1;
  } catch (err) {
    console.error('  \u2717', name);
    console.error('    ', err.message);
    process.exitCode = 1;
  }
}

(async function run() {
  console.log('AUTO-PAYOUT TEST SUITE (NOWPayments mocked)\n');

  await test('TOTP generates a valid rotating 6-digit code (real, not mocked)', () => {
    const a = totp(process.env.NOWPAYMENTS_2FA_SECRET, { timestamp: 1700000000000 });
    const b = totp(process.env.NOWPAYMENTS_2FA_SECRET, { timestamp: 1700000000000 });
    const c = totp(process.env.NOWPAYMENTS_2FA_SECRET, { timestamp: 1700000060000 });
    assert(/^\d{6}$/.test(a), 'not 6 digits');
    assert.strictEqual(a, b, 'not deterministic within window');
    assert.notStrictEqual(a, c, 'did not change across windows');
  });

  await test('small crypto withdrawal AUTO-fires (under both caps)', async () => {
    const uid = makeUser(100000);
    const w = requestWithdrawal(uid, 15000); // $150 < $200 cap
    const out = await maybeAutoPayout(w.id);
    assert.strictEqual(out.auto, true, 'should have auto-paid');
    assert.strictEqual(payoutCalls.length, 1, 'payout API not called once');
    const after = db.prepare('SELECT status, admin_note FROM withdrawals WHERE id = ?').get(w.id);
    assert.strictEqual(after.status, 'processing', 'status not processing');
    assert.strictEqual(after.admin_note, 'auto payout', 'not tagged auto');
  });

  await test('over per-withdrawal cap FALLS BACK to manual queue', async () => {
    const uid = makeUser(100000);
    const w = requestWithdrawal(uid, 25000); // $250 > $200 cap
    const out = await maybeAutoPayout(w.id);
    assert.strictEqual(out.auto, false, 'should not auto-pay');
    assert.strictEqual(payoutCalls.length, 0, 'payout API should not be called');
    const after = db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(w.id);
    assert.strictEqual(after.status, 'pending', 'should stay pending for manual queue');
  });

  await test('user hitting 24h cap FALLS BACK on the withdrawal that crosses it', async () => {
    const uid = makeUser(200000);
    // Three $180 auto payouts = $540 > $500 daily cap. First two pass, third falls back.
    const w1 = requestWithdrawal(uid, 18000);
    const o1 = await maybeAutoPayout(w1.id);
    const w2 = requestWithdrawal(uid, 18000);
    const o2 = await maybeAutoPayout(w2.id);
    const w3 = requestWithdrawal(uid, 18000);
    const o3 = await maybeAutoPayout(w3.id);
    assert.strictEqual(o1.auto, true, 'first should auto');
    assert.strictEqual(o2.auto, true, 'second should auto');
    assert.strictEqual(o3.auto, false, 'third crosses $500 cap, should fall back');
    const after3 = db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(w3.id);
    assert.strictEqual(after3.status, 'pending', 'third should be pending');
  });

  await test('API failure leaves withdrawal PENDING (nothing stuck)', async () => {
    const uid = makeUser(100000);
    const w = requestWithdrawal(uid, 10000); // $100, within caps
    mockMode = 'fail';
    const out = await maybeAutoPayout(w.id);
    assert.strictEqual(out.auto, false, 'failed payout should report not-auto');
    assert.strictEqual(payoutCalls.length, 1, 'should have attempted the call once');
    const after = db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(w.id);
    assert.strictEqual(after.status, 'pending', 'must stay pending after failure');
  });

  await test('PayPal withdrawal never auto-pays (manual only)', async () => {
    const uid = makeUser(100000);
    const w = requestWithdrawal(uid, 10000, { method: 'paypal', destination: 'me@paypal.com' });
    const decision = evaluateAutoPayout(w);
    assert.strictEqual(decision.auto, false, 'paypal should not auto-pay');
  });

  await test('webhook flips a processing payout to PAID', async () => {
    const uid = makeUser(100000);
    const w = requestWithdrawal(uid, 12000);
    await maybeAutoPayout(w.id);
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id);
    // Simulate the payout IPN body our webhook expects
    const { handlePayoutIpn } = require('./webhook-harness');
    handlePayoutIpn({ id: row.np_withdrawal_id, batch_withdrawal_id: row.np_batch_id, status: 'finished', address: row.destination });
    const after = db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(w.id);
    assert.strictEqual(after.status, 'paid', 'webhook should mark it paid');
  });

  await test('webhook returns a FAILED payout to the queue', async () => {
    const uid = makeUser(100000);
    const w = requestWithdrawal(uid, 12000);
    await maybeAutoPayout(w.id);
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id);
    const balBefore = db.prepare('SELECT site_credit_cents FROM users WHERE id = ?').get(uid).site_credit_cents;
    const { handlePayoutIpn } = require('./webhook-harness');
    handlePayoutIpn({ id: row.np_withdrawal_id, batch_withdrawal_id: row.np_batch_id, status: 'failed', address: row.destination });
    const after = db.prepare('SELECT status FROM withdrawals WHERE id = ?').get(w.id);
    assert.strictEqual(after.status, 'pending', 'failed payout should return to queue');
  });

  await test('fee-on-top math: $25 item -> buyer $26.50, seller keeps $25, platform $1.50', () => {
    const { amountCents, feeCents, sellerProceedsCents } = computeOrderAmounts(2500);
    assert.strictEqual(amountCents, 2650);
    assert.strictEqual(feeCents, 150);
    assert.strictEqual(sellerProceedsCents, 2500);
    assert.strictEqual(sellerProceedsCents + feeCents, amountCents, 'accounting identity broken');
  });

  console.log(`\n${passed} passed`);
  require('fs').rmSync(process.env.DB_PATH, { force: true });
})();
