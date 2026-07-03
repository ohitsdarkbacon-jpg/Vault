const db = require('../db');

// Attaches req.user if a valid session with a userId exists.
function attachUser(req, res, next) {
  req.user = null;
  const uid = req.session && req.session.userId;
  if (uid) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (user && !user.is_banned) req.user = user;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

module.exports = { attachUser, requireAuth };
