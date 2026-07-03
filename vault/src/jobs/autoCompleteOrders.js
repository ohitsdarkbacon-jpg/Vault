const db = require('../db');
const { releaseEscrow } = require('../lib/fulfillOrder');

// How long a buyer has after "delivered" to confirm or dispute before
// escrow auto-releases to the seller. Disputed orders are never auto-released.
const AUTO_COMPLETE_HOURS = parseInt(process.env.AUTO_COMPLETE_HOURS || '72', 10);

function autoCompleteDeliveredOrders() {
  const rows = db
    .prepare(
      `SELECT id FROM orders
       WHERE status = 'delivered' AND escrow_released = 0
         AND delivered_at <= datetime('now', ?)`
    )
    .all(`-${AUTO_COMPLETE_HOURS} hours`);
  if (!rows.length) return;
  rows.forEach((r) => releaseEscrow(r.id, { reason: 'auto_complete' }));
  console.log(`[autoComplete] released ${rows.length} order(s) after ${AUTO_COMPLETE_HOURS}h window`);
}

function startAutoComplete(intervalMs = 5 * 60 * 1000) {
  autoCompleteDeliveredOrders();
  return setInterval(autoCompleteDeliveredOrders, intervalMs);
}

module.exports = { startAutoComplete, autoCompleteDeliveredOrders };
