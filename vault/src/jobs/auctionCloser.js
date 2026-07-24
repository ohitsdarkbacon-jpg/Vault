const db = require('../db');
const { notify } = require('../lib/notify');

function closeExpiredAuctions() {
  // ends_at is an ISO string with a 'T' separator; datetime('now') is
  // space-separated — comparing them as strings silently fails for same-day
  // timestamps. julianday() parses both formats correctly.
  const expired = db
    .prepare("SELECT * FROM auctions WHERE status = 'live' AND julianday(ends_at) <= julianday('now')")
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

// Ping watchers (favoriters) and the current high bidder once when a live
// auction crosses into its final hour.
function sendEndingSoonAlerts() {
  const closing = db
    .prepare(
      `SELECT * FROM auctions WHERE status = 'live' AND ending_alert_sent = 0
       AND julianday(ends_at) <= julianday('now', '+1 hour') AND julianday(ends_at) > julianday('now')`
    )
    .all();
  if (!closing.length) return;
  const flag = db.prepare('UPDATE auctions SET ending_alert_sent = 1 WHERE id = ?');
  for (const a of closing) {
    flag.run(a.id);
    const price = `$${((a.current_bid_cents || a.starting_bid_cents) / 100).toFixed(2)}`;
    const watchers = db
      .prepare("SELECT user_id FROM favorites WHERE kind = 'auction' AND item_id = ? AND user_id != ?")
      .all(a.id, a.seller_id);
    const alerted = new Set();
    for (const w of watchers) {
      alerted.add(w.user_id);
      notify(w.user_id, 'ending_soon', `⏰ "${a.title}" ends in under an hour — currently ${price}.`, `#auction-${a.id}`);
    }
    if (a.current_bidder_id && !alerted.has(a.current_bidder_id)) {
      notify(a.current_bidder_id, 'ending_soon', `⏰ "${a.title}" ends in under an hour — you're the high bidder at ${price}.`, `#auction-${a.id}`);
    }
  }
  console.log(`[auctionCloser] sent ending-soon alerts for ${closing.length} auction(s)`);
}

// Flash listings: flip past-expiry actives to 'expired' so they drop out of
// browse/search. Purchase paths also check expires_at directly, so nothing
// can be bought in the window between real expiry and this sweep.
function expireFlashListings() {
  const expired = db
    .prepare("SELECT id, seller_id, title FROM listings WHERE status = 'active' AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now')")
    .all();
  if (!expired.length) return;
  const stmt = db.prepare("UPDATE listings SET status = 'expired' WHERE id = ? AND status = 'active'");
  const tx = db.transaction((rows) => rows.forEach((r) => stmt.run(r.id)));
  tx(expired);
  for (const l of expired) {
    notify(l.seller_id, 'flash_expired', `⚡ Your flash listing "${l.title}" expired without selling.`, '#dashboard');
  }
  console.log(`[auctionCloser] expired ${expired.length} flash listing(s)`);
}

function tick() {
  closeExpiredAuctions();
  sendEndingSoonAlerts();
  expireFlashListings();
}

function startAuctionCloser(intervalMs = 30000) {
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { startAuctionCloser, closeExpiredAuctions, sendEndingSoonAlerts };
