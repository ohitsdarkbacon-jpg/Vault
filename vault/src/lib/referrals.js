// Referral programme.
//
// Rewards:
//  - Signing up through an invite instantly gives BOTH sides a day of Vault
//    Pro — the newcomer and the person whose link they used.
//  - The inviter also earns site credit, but only once the newcomer completes
//    their first real order.
//
// Anti-abuse model:
//  - A code is attributed exactly once, at account creation, and only to a
//    brand-new account (referrals.referred_id is UNIQUE).
//  - You can never refer yourself.
//  - Pro time can't be withdrawn, and the Pro days an inviter can earn from
//    signups are capped for life, so throwaway accounts can't mint membership.
//  - Cash is never paid at signup — it needs a completed order, so farming
//    costs more than the reward.
const crypto = require('crypto');
const db = require('../db');
const { notify } = require('./notify');
const { grantProDays } = require('./pro');
const {
  referralReferrerRewardCents,
  referralSignupBonusCents,
  referralSignupProDays,
  referralMaxSignupProDays,
} = require('../config');

// Unambiguous alphabet — no O/0, I/1, so codes survive being read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 7;
const VANITY_RE = /^[A-Za-z0-9_-]{3,20}$/;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Every user's code is created lazily the first time it's needed.
function codeFor(userId) {
  const row = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    try {
      db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
      return code;
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e; // collision — try again
    }
  }
  return null;
}

function userByCode(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return db.prepare('SELECT * FROM users WHERE referral_code = ? COLLATE NOCASE').get(c) || null;
}

// Pro days this user has already earned from invite signups (lifetime).
function signupProDaysEarned(userId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(referrer_pro_days), 0) AS d FROM referrals WHERE referrer_id = ?')
    .get(userId);
  return row.d || 0;
}

/**
 * Attribute a brand-new account to a referral code and hand both sides their
 * welcome day of Pro. Safe to call with junk — anything invalid is simply
 * ignored. Returns true when attribution stuck.
 */
function applyReferral(newUserId, code) {
  if (!code) return false;
  const referrer = userByCode(code);
  if (!referrer || referrer.id === newUserId || referrer.is_banned) return false;
  const existing = db.prepare('SELECT 1 FROM referrals WHERE referred_id = ?').get(newUserId);
  if (existing) return false;

  const gift = Math.max(0, referralSignupProDays);
  // The inviter's side is capped for life so mass signups can't mint Pro.
  const referrerGift = gift && signupProDaysEarned(referrer.id) + gift <= referralMaxSignupProDays ? gift : 0;

  try {
    db.transaction(() => {
      db.prepare('INSERT INTO referrals (referrer_id, referred_id, referred_pro_days, referrer_pro_days) VALUES (?, ?, ?, ?)')
        .run(referrer.id, newUserId, gift, referrerGift);
      db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(referrer.id, newUserId);
      if (gift) grantProDays(newUserId, gift);
      if (referrerGift) grantProDays(referrer.id, referrerGift);
    })();
  } catch (_) {
    return false; // raced with another signup path
  }

  const dayWord = (n) => `${n} day${n === 1 ? '' : 's'}`;
  notify(
    referrer.id,
    'referral',
    referrerGift
      ? `🎉 Someone joined with your invite link — ${dayWord(referrerGift)} of Vault Pro added to your account! You also earn credit once they complete their first trade.`
      : '🎉 Someone joined Vault with your invite link! You earn credit once they complete their first trade.',
    '#dashboard'
  );
  if (gift) {
    notify(newUserId, 'referral', `⭐ Welcome! You got ${dayWord(gift)} of Vault Pro free for joining through an invite — enjoy the reduced fees.`, '#dashboard');
  }
  return true;
}

/**
 * Called when a user completes an order. Pays out their pending referral
 * (if any) exactly once. Idempotent: a qualified row is never paid twice.
 */
function qualifyReferral(userId) {
  const ref = db.prepare("SELECT * FROM referrals WHERE referred_id = ? AND status = 'pending'").get(userId);
  if (!ref) return false;
  const referrerReward = Math.max(0, referralReferrerRewardCents);
  const referredReward = Math.max(0, referralSignupBonusCents);

  db.transaction(() => {
    // Guarded update — if another request qualified it first, we do nothing.
    const res = db
      .prepare("UPDATE referrals SET status = 'qualified', referrer_reward_cents = ?, referred_reward_cents = ?, qualified_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(referrerReward, referredReward, ref.id);
    if (!res.changes) return;
    if (referrerReward) {
      db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(referrerReward, ref.referrer_id);
    }
    if (referredReward) {
      db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(referredReward, ref.referred_id);
    }
  })();

  const fresh = db.prepare('SELECT status FROM referrals WHERE id = ?').get(ref.id);
  if (!fresh || fresh.status !== 'qualified') return false;
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  if (referrerReward) {
    notify(ref.referrer_id, 'referral', `💰 Referral reward: ${money(referrerReward)} added to your balance — someone you invited completed their first trade!`, '#dashboard');
  }
  if (referredReward) {
    notify(ref.referred_id, 'referral', `🎁 Welcome bonus: ${money(referredReward)} added to your balance for joining through an invite.`, '#dashboard');
  }
  return true;
}

// Counts + earnings for the dashboard.
function statsFor(userId) {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        COALESCE(SUM(referrer_reward_cents), 0) AS earned_cents,
        COALESCE(SUM(referrer_pro_days), 0) AS pro_days
       FROM referrals WHERE referrer_id = ?`
    )
    .get(userId);
  return {
    total: row.total || 0,
    qualified: row.qualified || 0,
    pending: row.pending || 0,
    earned_cents: row.earned_cents || 0,
    pro_days: row.pro_days || 0,
    pro_days_cap: referralMaxSignupProDays,
  };
}

module.exports = { codeFor, userByCode, applyReferral, qualifyReferral, statsFor, signupProDaysEarned, VANITY_RE, randomCode };
