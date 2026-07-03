const db = require('../db');

/**
 * Creates an in-app notification for a user.
 * type: outbid | auction_won | auction_sold | item_sold | order_paid |
 *       order_delivered | order_completed | order_disputed | order_refunded |
 *       new_message | review | withdrawal | admin
 */
function notify(userId, type, body, link = null) {
  try {
    db.prepare(
      'INSERT INTO notifications (user_id, type, body, link) VALUES (?, ?, ?, ?)'
    ).run(userId, type, body, link);
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

function notifyAdmins(type, body, link = null) {
  const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
  admins.forEach((a) => notify(a.id, type, body, link));
}

module.exports = { notify, notifyAdmins };
