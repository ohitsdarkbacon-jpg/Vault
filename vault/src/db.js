const path = require('path');
const { openDatabase } = require('./lib/sqlite-compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'vault.db');
const db = openDatabase(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT UNIQUE NOT NULL,  -- external OAuth id (Discord user id)
  username TEXT NOT NULL,
  avatar_url TEXT,
  site_credit_cents INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  price_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active | sold | removed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  starting_bid_cents INTEGER NOT NULL,
  current_bid_cents INTEGER,
  current_bidder_id INTEGER REFERENCES users(id),
  min_increment_cents INTEGER NOT NULL DEFAULT 100,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live', -- live | ended | paid | cancelled
  winner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  bidder_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  listing_id INTEGER REFERENCES listings(id),
  auction_id INTEGER REFERENCES auctions(id),
  amount_cents INTEGER NOT NULL,      -- total charged to buyer
  fee_cents INTEGER NOT NULL,         -- platform cut
  seller_proceeds_cents INTEGER NOT NULL,
  method TEXT NOT NULL,               -- stripe | crypto | credit
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  stripe_session_id TEXT,
  nowpayments_payment_id TEXT,
  pay_currency TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_stripe ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_nowpayments ON orders(nowpayments_payment_id);
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price_cents);
CREATE INDEX IF NOT EXISTS idx_listings_created ON listings(created_at);
CREATE INDEX IF NOT EXISTS idx_auctions_ends_at ON auctions(ends_at);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
`);

// ---- Full-text search (server-side search for listings & auctions) ----
// FTS5 ships enabled-by-default in better-sqlite3's bundled SQLite build, but we
// guard with try/catch and expose db.ftsAvailable so routes can fall back to a
// plain LIKE search if a given deployment's SQLite build lacks it.
let ftsAvailable = true;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
      title, description, content='listings', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS listings_fts_ai AFTER INSERT ON listings BEGIN
      INSERT INTO listings_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
    END;
    CREATE TRIGGER IF NOT EXISTS listings_fts_ad AFTER DELETE ON listings BEGIN
      INSERT INTO listings_fts(listings_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
    END;
    CREATE TRIGGER IF NOT EXISTS listings_fts_au AFTER UPDATE ON listings BEGIN
      INSERT INTO listings_fts(listings_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
      INSERT INTO listings_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS auctions_fts USING fts5(
      title, description, content='auctions', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS auctions_fts_ai AFTER INSERT ON auctions BEGIN
      INSERT INTO auctions_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
    END;
    CREATE TRIGGER IF NOT EXISTS auctions_fts_ad AFTER DELETE ON auctions BEGIN
      INSERT INTO auctions_fts(auctions_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
    END;
    CREATE TRIGGER IF NOT EXISTS auctions_fts_au AFTER UPDATE ON auctions BEGIN
      INSERT INTO auctions_fts(auctions_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
      INSERT INTO auctions_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
    END;
  `);

  // Backfill the FTS index for rows that existed before this table was added
  // (e.g. a DB file created by an older version of this app).
  const backfill = (table) => {
    const { c: rowCount } = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get();
    const { c: ftsCount } = db.prepare(`SELECT COUNT(*) c FROM ${table}_fts`).get();
    if (rowCount > 0 && ftsCount === 0) {
      db.prepare(
        `INSERT INTO ${table}_fts(rowid, title, description) SELECT id, title, description FROM ${table}`
      ).run();
    }
  };
  backfill('listings');
  backfill('auctions');
} catch (err) {
  ftsAvailable = false;
  console.warn('[db] FTS5 unavailable, search will fall back to LIKE queries:', err.message);
}

db.ftsAvailable = ftsAvailable;

module.exports = db;

// ============================================================
// v2 schema — escrow, messaging, reviews, notifications,
// withdrawals, favorites, admin
// ============================================================

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('users', 'bio', 'bio TEXT');
ensureColumn('users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'delivered_at', 'delivered_at TEXT');
ensureColumn('orders', 'completed_at', 'completed_at TEXT');
ensureColumn('orders', 'disputed_at', 'disputed_at TEXT');
ensureColumn('orders', 'dispute_reason', 'dispute_reason TEXT');
ensureColumn('orders', 'escrow_released', 'escrow_released INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_seller ON reviews(seller_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('listing','auction')),
  item_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, item_id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('paypal','crypto')),
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | rejected
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
`);

// Columns added after v2 shipped — safe no-ops on fresh databases
ensureColumn('withdrawals', 'currency', 'currency TEXT');                 // crypto payout currency (btc, usdttrc20, ...)
ensureColumn('withdrawals', 'np_batch_id', 'np_batch_id TEXT');           // NOWPayments payout batch id
ensureColumn('withdrawals', 'np_withdrawal_id', 'np_withdrawal_id TEXT'); // NOWPayments withdrawal id (for IPN matching)

// ============================================================
// v3 schema — direct messages, trader directory privacy,
// presence, blocks, reports
// ============================================================

ensureColumn('users', 'profile_hidden', 'profile_hidden INTEGER NOT NULL DEFAULT 0'); // hide from the trader directory + private profile page
ensureColumn('users', 'last_seen_at', 'last_seen_at TEXT');                           // presence — touched at most once a minute

db.exec(`
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_id, is_read);
CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id, recipient_id, id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  blocked_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reported_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
`);

// ============================================================
// v4 schema — offers/negotiation, auction buyouts, verified
// traders, ending-soon alerts
// ============================================================

ensureColumn('users', 'is_verified', 'is_verified INTEGER NOT NULL DEFAULT 0');       // admin-granted trust badge
ensureColumn('auctions', 'buyout_cents', 'buyout_cents INTEGER');                     // optional Buy It Now price
ensureColumn('auctions', 'ending_alert_sent', 'ending_alert_sent INTEGER NOT NULL DEFAULT 0'); // watchers alerted <1h left

db.exec(`
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  counter_cents INTEGER,               -- seller's counter-offer, when status = 'countered'
  status TEXT NOT NULL DEFAULT 'pending', -- pending | countered | accepted | declined | withdrawn | expired | completed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_listing ON offers(listing_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_buyer ON offers(buyer_id, status);
`);

// Seed admins from env: comma-separated Roblox user IDs
const adminIds = (process.env.ADMIN_DISCORD_IDS || process.env.ADMIN_ROBLOX_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (adminIds.length) {
  const stmt = db.prepare('UPDATE users SET is_admin = 1 WHERE provider_id = ?');
  adminIds.forEach((id) => stmt.run(id));
  db.adminProviderIds = new Set(adminIds);
} else {
  db.adminProviderIds = new Set();
}
