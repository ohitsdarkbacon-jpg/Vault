const db = require('../db');

// Attaches req.user if a valid session with a userId exists.
function attachUser(req, res, next) {
  req.user = null;
  const uid = req.session && req.session.userId;
  if (uid) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (user && !user.is_banned) {
      req.user = user;
      // Presence: touch last_seen_at at most once a minute so the trader
      // directory can show who's online without a write on every request.
      const seen = user.last_seen_at ? Date.parse(user.last_seen_at + 'Z') : 0;
      if (Date.now() - seen > 60000) {
        db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(user.id);
      }
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

module.exports = { attachUser, requireAuth };
