const db = require('../db');
const { notify } = require('./notify');

/**
 * Marks an order as paid and moves the buyer's money into ESCROW.
 *
 * The seller is NOT credited here. Funds are held until either:
 *   - the buyer confirms receipt (POST /api/orders/:id/confirm), or
 *   - the auto-complete job releases a delivered order after the
 *     protection window (default 72h), or
 *   - an admin resolves a dispute in the seller's favor.
 * Seller crediting happens in releaseEscrow() below.
 *
 * Idempotent — safe to call multiple times for the same order
 * (e.g. retried webhooks).
 */
function fulfillOrder(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    console.warn(`[fulfillOrder] order ${orderId} not found`);
    return;
  }
  if (order.status !== 'pending') return; // already handled

  // Double-sell guard: the item stays purchasable while card/crypto checkouts
  // are in flight, so two buyers can both pay for the same listing/auction.
  // First payment to arrive wins; any later one is refunded as site credit.
  const rival = db
    .prepare(
      `SELECT id FROM orders
       WHERE id != ? AND status IN ('paid', 'delivered', 'completed')
         AND ((? IS NOT NULL AND listing_id = ?) OR (? IS NOT NULL AND auction_id = ?))`
    )
    .get(order.id, order.listing_id, order.listing_id, order.auction_id, order.auction_id);
  if (rival) {
    const item = getOrderItemTitle(order);
    db.transaction(() => {
      db.prepare(
        `UPDATE orders SET status = 'refunded', escrow_released = 1, updated_at = datetime('now') WHERE id = ?`
      ).run(order.id);
      db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(
        order.amount_cents,
        order.buyer_id
      );
    })();
    notify(
      order.buyer_id,
      'order_refunded',
      `"${item}" was bought by someone else moments before your payment confirmed. Your $${(order.amount_cents / 100).toFixed(2)} was refunded as site credit.`,
      `#dashboard`
    );
    console.warn(`[fulfillOrder] order ${order.id} lost the race to order ${rival.id} — auto-refunded as credit`);
    return;
  }

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = ?"
    ).run(order.id);
    if (order.listing_id) {
      db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(order.listing_id);
    }
    if (order.auction_id) {
      db.prepare("UPDATE auctions SET status = 'paid' WHERE id = ?").run(order.auction_id);
    }
  });
  tx();

  const item = getOrderItemTitle(order);
  notify(
    order.seller_id,
    'item_sold',
    `"${item}" sold! Payment is held in escrow — deliver the item in Roblox, then mark it delivered.`,
    `#order-${order.id}`
  );
  notify(
    order.buyer_id,
    'order_paid',
    `Payment received for "${item}". Coordinate the trade with the seller via order chat, then confirm receipt to release payment.`,
    `#order-${order.id}`
  );
  console.log(`[fulfillOrder] order ${order.id} paid — funds in escrow`);
}

/**
 * Releases escrowed funds to the seller and completes the order.
 * Idempotent via the escrow_released flag.
 */
function releaseEscrow(orderId, { reason = 'buyer_confirmed' } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.escrow_released) return false;
  if (!['paid', 'delivered', 'disputed'].includes(order.status)) return false;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE orders SET status = 'completed', escrow_released = 1,
       completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(order.id);
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(
      order.seller_proceeds_cents,
      order.seller_id
    );
  });
  tx();

  const item = getOrderItemTitle(order);
  notify(
    order.seller_id,
    'order_completed',
    `Order for "${item}" completed — $${(order.seller_proceeds_cents / 100).toFixed(2)} added to your balance.`,
    `#order-${order.id}`
  );
  notify(
    order.buyer_id,
    'order_completed',
    `Order for "${item}" is complete. You can leave the seller a review.`,
    `#order-${order.id}`
  );
  console.log(`[releaseEscrow] order ${order.id} (${reason}) — seller ${order.seller_id} credited ${order.seller_proceeds_cents}c`);
  return true;
}

/**
 * Refunds an escrowed order to the buyer as site credit (used by admin
 * dispute resolution). Card/crypto rails don't auto-refund here — the
 * buyer gets site credit for the full amount, which they can spend or
 * withdraw.
 */
function refundOrder(orderId, { note = null } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.escrow_released) return false;
  if (!['paid', 'delivered', 'disputed'].includes(order.status)) return false;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE orders SET status = 'refunded', escrow_released = 1,
       updated_at = datetime('now') WHERE id = ?`
    ).run(order.id);
    db.prepare('UPDATE users SET site_credit_cents = site_credit_cents + ? WHERE id = ?').run(
      order.amount_cents,
      order.buyer_id
    );
    // Re-open the listing so the seller can sell it again
    if (order.listing_id) {
      db.prepare("UPDATE listings SET status = 'active' WHERE id = ? AND status = 'sold'").run(order.listing_id);
    }
  });
  tx();

  const item = getOrderItemTitle(order);
  notify(order.buyer_id, 'order_refunded', `Order for "${item}" was refunded — $${(order.amount_cents / 100).toFixed(2)} added to your balance.${note ? ' Note: ' + note : ''}`, `#order-${order.id}`);
  notify(order.seller_id, 'order_refunded', `Order for "${item}" was refunded to the buyer.${note ? ' Note: ' + note : ''}`, `#order-${order.id}`);
  return true;
}

function getOrderItemTitle(order) {
  if (order.listing_id) {
    const l = db.prepare('SELECT title FROM listings WHERE id = ?').get(order.listing_id);
    if (l) return l.title;
  }
  if (order.auction_id) {
    const a = db.prepare('SELECT title FROM auctions WHERE id = ?').get(order.auction_id);
    if (a) return a.title;
  }
  return `Order #${order.id}`;
}

module.exports = { fulfillOrder, releaseEscrow, refundOrder, getOrderItemTitle };
