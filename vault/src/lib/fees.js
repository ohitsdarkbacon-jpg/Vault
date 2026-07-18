const { platformFeeBps, proFeeBps, feeMode } = require('../config');

// A user row is Pro while their paid-through timestamp is in the future.
function isPro(user) {
  return !!(user && user.pro_until && Date.parse(user.pro_until) > Date.now());
}

// The buyer fee rate that applies to a given buyer (Pro pays the reduced rate).
function feeBpsFor(buyer) {
  return isPro(buyer) ? proFeeBps : platformFeeBps;
}

/**
 * Turns a listing price / winning bid into the three numbers every order needs.
 * Pass the buyer (user row) so Pro subscribers get their reduced fee.
 *
 * feeMode 'added'    (default): buyer pays base + fee, seller receives base.
 * feeMode 'deducted':           buyer pays base, seller receives base - fee.
 * Either way the platform keeps feeCents and amount = proceeds + fee always holds.
 */
function computeOrderAmounts(baseCents, buyer = null) {
  const feeCents = Math.round((baseCents * feeBpsFor(buyer)) / 10000);
  if (feeMode === 'added') {
    return { amountCents: baseCents + feeCents, feeCents, sellerProceedsCents: baseCents };
  }
  return { amountCents: baseCents, feeCents, sellerProceedsCents: baseCents - feeCents };
}

// Back-compat alias (old signature returned only the split for a given charge)
function splitFee(amountCents) {
  const feeCents = Math.round((amountCents * platformFeeBps) / 10000);
  return { feeCents, sellerProceedsCents: amountCents - feeCents };
}

module.exports = { computeOrderAmounts, splitFee, isPro, feeBpsFor };
