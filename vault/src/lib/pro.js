// Vault Pro membership time.
//
// One place that knows how to add paid-through days, so purchases, renewals
// and promo grants (e.g. the referral welcome day) all stack identically.
const db = require('../db');

/**
 * Extends a member's paid-through date by `days`, counting from whichever is
 * later: now, or their current expiry — so topping up early never loses time.
 * Returns the new ISO expiry.
 */
function grantProDays(userId, days) {
  const u = db.prepare('SELECT pro_until FROM users WHERE id = ?').get(userId);
  const base = u && u.pro_until && Date.parse(u.pro_until) > Date.now() ? Date.parse(u.pro_until) : Date.now();
  const until = new Date(base + days * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET pro_until = ? WHERE id = ?').run(until, userId);
  return until;
}

module.exports = { grantProDays };
