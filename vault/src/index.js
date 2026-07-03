const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const db = require('./db'); // ensures schema is created on boot

const { attachUser, requireAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const listingsRoutes = require('./routes/listings');
const auctionsRoutes = require('./routes/auctions');
const paymentsRoutes = require('./routes/payments');
const { router: webhooksRouter, stripeWebhookHandler } = require('./routes/webhooks');
const ordersRoutes = require('./routes/orders');
const usersRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const { startAuctionCloser } = require('./jobs/auctionCloser');
const { startAutoComplete } = require('./jobs/autoCompleteOrders');

const app = express();
app.set('trust proxy', 1);

// ---- Stripe webhook must see the RAW body for signature verification,
// so this is registered before the global express.json() parser below. ----
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json({ limit: '1mb' }));
app.use(
  cookieSession({
    name: 'vault.sid',
    secret: config.sessionSecret,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
    secure: config.isProd,
    httpOnly: true,
  })
);
app.use(attachUser);

// Basic abuse protection on write-heavy endpoints
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api', writeLimiter);

// Tighter limit on bid spam
const bidLimiter = rateLimit({ windowMs: 10 * 1000, max: 6, standardHeaders: true, legacyHeaders: false });
app.use('/api/auctions/:id/bid', bidLimiter);
const messageLimiter = rateLimit({ windowMs: 10 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
app.use('/api/orders/:id/messages', messageLimiter);

// ---- API routes ----
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { id, provider_id, username, avatar_url, site_credit_cents, is_admin, bio, created_at } = req.user;
  res.json({ user: { id, provider_id, username, avatar_url, site_credit_cents, is_admin, bio, created_at } });
});

app.get('/api/config', (req, res) => {
  res.json({ fee_bps: config.platformFeeBps, fee_mode: config.feeMode });
});

app.get('/api/stats', (req, res) => {
  const s = db.prepare(`SELECT
    (SELECT COUNT(*) FROM auctions WHERE status = 'live') AS live_auctions,
    (SELECT COUNT(*) FROM listings WHERE status = 'active') AS active_listings,
    (SELECT COUNT(*) FROM orders WHERE status = 'completed') AS completed_trades,
    (SELECT COUNT(*) FROM users) AS traders`).get();
  res.json(s);
});

app.use('/auth', authRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/auctions', auctionsRoutes);
app.use('/api/orders', ordersRoutes);   // lifecycle, chat, reviews (must be before paymentsRoutes' /orders/:id)
app.use('/api', usersRoutes);           // /api/users/:username, /api/my/*, /api/favorites/*
app.use('/api/admin', adminRoutes);
app.use('/api', paymentsRoutes); // /api/auctions/:id/checkout/*, /api/listings/:id/checkout/*
app.use('/webhooks', webhooksRouter); // /webhooks/nowpayments (stripe handled above)

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhooks')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

startAuctionCloser();
startAutoComplete();

app.listen(config.port, () => {
  console.log(`Vault backend listening on http://localhost:${config.port}`);
});
