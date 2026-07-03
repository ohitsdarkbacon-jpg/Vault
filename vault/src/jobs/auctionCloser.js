const db = require('../db');
const { notify } = require('../lib/notify');

function closeExpiredAuctions() {
  const expired = db
    .prepare("SELECT * FROM auctions WHERE status = 'live' AND ends_at <= datetime('now')")
    .all();
  if (!expired.length) return;
  const stmt = db.prepare(
    "UPDATE auctions SET status = 'ended', winner_id = current_bidder_id WHERE id = ?"
  );
  const tx = db.transaction((rows) => rows.forEach((r) => stmt.run(r.id)));
  tx(expired);

  for (const a of expired) {
    if (a.current_bidder_id) {
      notify(
        a.current_bidder_id,
        'auction_won',
        `You won "${a.title}" for $${((a.current_bid_cents || a.starting_bid_cents) / 100).toFixed(2)}! Complete checkout to claim it.`,
        `#auction-${a.id}`
      );
      notify(
        a.seller_id,
        'auction_sold',
        `Your auction "${a.title}" ended at $${((a.current_bid_cents || a.starting_bid_cents) / 100).toFixed(2)} — waiting for the winner to pay.`,
        `#auction-${a.id}`
      );
    } else {
      notify(a.seller_id, 'auction_sold', `Your auction "${a.title}" ended with no bids.`, `#auction-${a.id}`);
    }
  }
  console.log(`[auctionCloser] closed ${expired.length} expired auction(s)`);
}

function startAuctionCloser(intervalMs = 30000) {
  closeExpiredAuctions();
  return setInterval(closeExpiredAuctions, intervalMs);
}

module.exports = { startAuctionCloser, closeExpiredAuctions };
