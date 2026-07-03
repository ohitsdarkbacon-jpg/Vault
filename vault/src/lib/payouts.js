const db = require('../db');
const config = require('../config');
const { notify, notifyAdmins } = require('./notify');
const np = require('./nowpayments');
const { payoutsEnabled, PAYOUT_FINISHED, PAYOUT_FAILED } = np;

/**
 * Decides whether a crypto withdrawal is allowed to auto-pay, or must fall
 * back to the manual admin queue. Returns { auto: boolean, reason: string }.
 *
 * A withdrawal auto-pays only when ALL of these hold:
 *   - auto-payout is enabled and NOWPayments payout creds are configured
 *   - it's a crypto withdrawal with a payout currency
 *   - the amount is at/under the per-withdrawal cap
 *   - the user hasn't exceeded the rolling 24h auto-paid cap (this one included)
 * Anything else → manual queue (safe default; nothing is ever stuck).
 */
function evaluateAutoPayout(withdrawal) {
  if (!config.autoPayout) return { auto: false, reason: 'auto-payout disabled' };
  if (!payoutsEnabled()) return { auto: false, reason: 'payout credentials not configured' };
  if (withdrawal.method !== 'crypto' || !withdrawal.currency) {
    return { auto: false, reason: 'not a crypto withdrawal' };
  }
  if (withdrawal.amount_cents > config.autoPayoutMaxCents) {
    return { auto: false, reason: 'over per-withdrawal cap' };
  }

  // Sum of already auto-paid / in-flight crypto payouts for this user in the
  // last 24h, plus this one. 'processing' and 'paid' both count as committed.
  const spent = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM withdrawals
       WHERE user_id = ? AND method = 'crypto'
         AND status IN ('processing', 'paid')
         AND admin_note = 'auto payout'
         AND created_at >= datetime('now', '-24 hours')`
    )
    .get(withdrawal.user_id).c;

  if (spent + withdrawal.amount_cents > config.autoPayoutDailyCapCents) {
    return { auto: false, reason: 'over 24h auto-payout cap' };
  }
  return { auto: true, reason: 'within limits' };
}

/**
 * Executes a NOWPayments payout for a withdrawal that's already been decided
 * eligible. Marks it 'processing' (the webhook later flips it to 'paid').
 * On failure, leaves the withdrawal 'pending' so it stays in the manual queue,
 * and alerts admins. Never throws — returns { ok, error? }.
 *
 * `markedAuto` tags the row (admin_note='auto payout') so the daily-cap query
 * and the webhook can recognise auto payouts.
 */
async function executePayout(withdrawal, { markedAuto = true } = {}) {
  try {
    const result = await np.createPayout({
      address: withdrawal.destination,
      currency: withdrawal.currency,
      amountUsd: withdrawal.amount_cents / 100,
      ipnCallbackUrl: `${config.baseUrl}/webhooks/nowpayments`,
    });
    db.prepare(
      `UPDATE withdrawals
       SET status = 'processing', np_batch_id = ?, np_withdrawal_id = ?,
           admin_note = CASE WHEN ? = 1 THEN 'auto payout' ELSE admin_note END
       WHERE id = ?`
    ).run(result.batchId, result.withdrawalId, markedAuto ? 1 : 0, withdrawal.id);

    notify(
      withdrawal.user_id,
      'withdrawal',
      `Your $${(withdrawal.amount_cents / 100).toFixed(2)} crypto withdrawal is on its way.`
    );
    return { ok: true, status: result.status };
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error('[payout] failed:', err.response?.data || err.message);
    // Stays 'pending' → visible in the manual queue for a human to retry.
    notifyAdmins(
      'withdrawal',
      `Auto-payout for withdrawal #${withdrawal.id} failed (${detail}). It's back in the manual queue.`,
      '#admin'
    );
    return { ok: false, error: detail };
  }
}

/**
 * Called right after a crypto withdrawal row is created. If it passes the
 * risk checks, fires the payout immediately; otherwise leaves it pending for
 * the admin queue. Fire-and-forget safe (awaited where possible, but a slow
 * payout API won't block the user's request path — see users route).
 */
async function maybeAutoPayout(withdrawalId) {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
  if (!w || w.status !== 'pending') return { auto: false };
  const decision = evaluateAutoPayout(w);
  if (!decision.auto) {
    console.log(`[payout] withdrawal #${w.id} → manual queue (${decision.reason})`);
    return { auto: false, reason: decision.reason };
  }
  const res = await executePayout(w, { markedAuto: true });
  return { auto: res.ok, reason: res.ok ? 'sent' : decision.reason, error: res.error };
}

/**
 * Processes a NOWPayments PAYOUT IPN (distinct from payment IPNs). Marks a
 * 'processing' withdrawal 'paid' when the transfer finishes, or returns it to
 * the manual queue if it failed. Returns true if this body was a payout IPN
 * (handled), false if it wasn't (so the caller can treat it as a payment IPN).
 */
function isPayoutIpn(body) {
  return Boolean(body.batch_withdrawal_id || (body.id && !body.payment_id && body.address));
}

function handlePayoutIpn(body) {
  const wid = String(body.id || '');
  const status = String(body.status || '').toLowerCase();
  const w = db
    .prepare('SELECT * FROM withdrawals WHERE np_withdrawal_id = ? OR np_batch_id = ?')
    .get(wid, String(body.batch_withdrawal_id || ''));
  if (w && w.status === 'processing') {
    if (PAYOUT_FINISHED.has(status)) {
      db.prepare("UPDATE withdrawals SET status = 'paid', processed_at = datetime('now'), admin_note = 'auto payout' WHERE id = ?").run(w.id);
      notify(w.user_id, 'withdrawal', `Your $${(w.amount_cents / 100).toFixed(2)} crypto withdrawal was sent. \u2705`);
    } else if (PAYOUT_FAILED.has(status)) {
      db.prepare("UPDATE withdrawals SET status = 'pending', np_batch_id = NULL, np_withdrawal_id = NULL WHERE id = ?").run(w.id);
      notifyAdmins('withdrawal', `Automated payout for withdrawal #${w.id} ${status.toUpperCase()} — check your NOWPayments balance and retry or pay manually.`, '#admin');
    }
  }
  return true;
}

module.exports = { evaluateAutoPayout, executePayout, maybeAutoPayout, isPayoutIpn, handlePayoutIpn };
