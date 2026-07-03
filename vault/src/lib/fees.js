const { platformFeeBps, feeMode } = require('../config');

/**
 * Turns a listing price / winning bid into the three numbers every order needs.
 *
 * feeMode 'added'    (default): buyer pays base + fee, seller receives base.
 * feeMode 'deducted':           buyer pays base, seller receives base - fee.
 * Either way the platform keeps feeCents and amount = proceeds + fee always holds.
 */
function computeOrderAmounts(baseCents) {
  const feeCents = Math.round((baseCents * platformFeeBps) / 10000);
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

module.exports = { computeOrderAmounts, splitFee };
