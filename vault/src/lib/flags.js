// Feature flags.
//
// Every optional section of the site is a row in site_flags, so a new feature
// can ship dark and be switched on from the admin panel without a deploy.
// Unknown keys default to ON, so adding a feature never requires a migration
// before it works — seed the row when you want it to be toggleable.
//
// Adding a new toggleable feature:
//   1. seed a key in db.js (site_flags)
//   2. guard the routes with requireFlag('my_feature')
//   3. gate the frontend nav/section with flagOn('my_feature')
const db = require('../db');

// Flags change rarely and are read on nearly every page load, so cache them
// for a few seconds instead of hitting SQLite each time.
let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

function allFlags() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = db.prepare('SELECT key, enabled, label FROM site_flags').all();
  cache = {};
  rows.forEach((r) => { cache[r.key] = { enabled: !!r.enabled, label: r.label }; });
  cachedAt = Date.now();
  return cache;
}

function invalidate() { cache = null; }

// Unknown key -> true, so code paths never break on a missing row.
function flagOn(key) {
  const f = allFlags()[key];
  return f ? f.enabled : true;
}

// Map of key -> bool for the client.
function publicFlags() {
  const out = {};
  Object.entries(allFlags()).forEach(([k, v]) => { out[k] = v.enabled; });
  return out;
}

// Express guard: 404s a whole feature's routes when its flag is off.
function requireFlag(key) {
  return (req, res, next) => {
    if (!flagOn(key)) return res.status(404).json({ error: 'This feature is currently disabled.' });
    next();
  };
}

function setFlag(key, enabled) {
  const res = db
    .prepare("UPDATE site_flags SET enabled = ?, updated_at = datetime('now') WHERE key = ?")
    .run(enabled ? 1 : 0, key);
  invalidate();
  return res.changes > 0;
}

module.exports = { flagOn, publicFlags, requireFlag, setFlag, allFlags, invalidate };
