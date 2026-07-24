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
const uploadsRoutes = require('./routes/uploads');
const dmRoutes = require('./routes/dm');
const offersRoutes = require('./routes/offers');
const { router: topupsRouter } = require('./routes/topups');
const { router: tradesRouter, startTicketRotator } = require('./routes/trades');
const tournamentsRouter = require('./routes/tournaments');
const { router: proRouter, startProRenewJob } = require('./routes/pro');
const communityRouter = require('./routes/community');
const lobbiesRouter = require('./routes/lobbies');
const { keysRouter, v1Router } = require('./routes/api');
const trustRouter = require('./routes/trust');
const chainsRouter = require('./routes/chains');
const eventsRouter = require('./routes/events');
const { isPro } = require('./lib/fees');
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

// Basic abuse protection. The site is polling-heavy by design (chat, DMs,
// notifications, lobby + voice presence), so the ceiling accommodates a
// legitimately active user; the real-time voice signalling path is exempt
// entirely (it's already gated to lobby members) so audio never stalls.
const realtimeVoice = (req) => /\/(voice\/|signal(\?|$))/.test(req.originalUrl || req.url);
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, skip: realtimeVoice });
app.use('/api', writeLimiter);

// Tighter limit on bid spam
const bidLimiter = rateLimit({ windowMs: 10 * 1000, max: 6, standardHeaders: true, legacyHeaders: false });
app.use('/api/auctions/:id/bid', bidLimiter);
const messageLimiter = rateLimit({ windowMs: 10 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
app.use('/api/orders/:id/messages', messageLimiter);
// DM sends are limited inside routes/dm.js (POST only — GET polling must stay free)

// ---- API routes ----
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { id, provider_id, username, avatar_url, site_credit_cents, is_admin, bio, created_at, profile_hidden, middleman_status } = req.user;
  res.json({ user: {
    id, provider_id, username, avatar_url, site_credit_cents, is_admin, bio, created_at, profile_hidden, middleman_status,
    pro: { active: isPro(req.user), until: req.user.pro_until || null, auto_renew: !!req.user.pro_auto_renew },
    wallet: req.user.wallet_address ? { address: req.user.wallet_address, currency: req.user.wallet_currency } : null,
  } });
});

app.get('/api/config', (req, res) => {
  res.json({
    fee_bps: config.platformFeeBps, fee_mode: config.feeMode, transfer_fee_bps: config.transferFeeBps,
    pro_fee_bps: config.proFeeBps, pro_price_cents: config.proPriceCents,
  });
});

// Game categories — admin-managed rows, consumed by every category picker
// and filter-chip row on the frontend.
app.get('/api/categories', (req, res) => {
  const rows = db.prepare("SELECT slug, label FROM categories ORDER BY CASE WHEN slug = 'other' THEN 1 ELSE 0 END, label").all();
  res.json({ categories: rows });
});

app.get('/api/stats', (req, res) => {
  const s = db.prepare(`SELECT
    (SELECT COUNT(*) FROM auctions WHERE status = 'live') AS live_auctions,
    (SELECT COUNT(*) FROM listings WHERE status = 'active') AS active_listings,
    (SELECT COUNT(*) FROM orders WHERE status = 'completed') AS completed_trades,
    (SELECT COUNT(*) FROM users) AS traders`).get();
  res.json(s);
});

// ---- Useful public endpoints -------------------------------------------
const BOOT_TIME = Date.now();

// Liveness/health probe (uptime monitors, load balancers, status pages).
app.get('/api/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch (_) { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    uptime_seconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
    time: new Date().toISOString(),
  });
});

// WebRTC ICE servers for the built-in lobby voice. Public STUN by default;
// set TURN_URL / TURN_USERNAME / TURN_PASSWORD for strict-NAT relaying.
app.get('/api/rtc-config', (req, res) => {
  const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
  if (process.env.TURN_URL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  }
  res.json({ iceServers });
});

// robots.txt — allow crawling of public pages, keep the API + auth out.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /dashboard\nSitemap: ${config.baseUrl}/sitemap.xml\n`);
});

// A tiny sitemap of the crawlable, shareable views.
app.get('/sitemap.xml', (req, res) => {
  const urls = ['/', '/#auctions', '/#listings', '/#trading', '/#tournaments', '/#traders', '/#traders-center', '/#lobbies', '/#how-it-works'];
  const today = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${config.baseUrl}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`
  );
});

// Most-watched live items — the 🔥 trending strip on the home page.
app.get('/api/trending', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM (
      SELECT 'listing' AS kind, l.id, l.title, l.image_url, l.price_cents AS price_cents,
        (SELECT COUNT(*) FROM favorites f WHERE f.kind = 'listing' AND f.item_id = l.id) AS watchers
      FROM listings l WHERE l.status = 'active'
      UNION ALL
      SELECT 'auction' AS kind, a.id, a.title, a.image_url,
        COALESCE(a.current_bid_cents, a.starting_bid_cents) AS price_cents,
        (SELECT COUNT(*) FROM favorites f WHERE f.kind = 'auction' AND f.item_id = a.id) AS watchers
      FROM auctions a WHERE a.status = 'live'
    ) WHERE watchers > 0 ORDER BY watchers DESC, id DESC LIMIT 6`
  ).all();
  res.json({ trending: rows });
});

// Latest site-wide announcement (last 7 days) — the dismissible banner.
// Public: signed-out visitors see it too.
app.get('/api/announcements/latest', (req, res) => {
  const a = db.prepare(
    `SELECT id, message, created_at FROM announcements
     WHERE julianday('now') - julianday(created_at) <= 7
     ORDER BY id DESC LIMIT 1`
  ).get();
  res.json({ announcement: a || null });
});

// Recent escrowed/completed trades — social proof for the home page.
app.get('/api/recent-sales', (req, res) => {
  const rows = db.prepare(
    `SELECT o.amount_cents, o.created_at,
      COALESCE(l.title, a.title) AS title,
      COALESCE(l.image_url, a.image_url) AS image_url
     FROM orders o
     LEFT JOIN listings l ON l.id = o.listing_id
     LEFT JOIN auctions a ON a.id = o.auction_id
     WHERE o.status IN ('paid','delivered','completed')
     ORDER BY o.id DESC LIMIT 8`
  ).all();
  res.json({ sales: rows });
});

app.use('/auth', authRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/auctions', auctionsRoutes);
app.use('/api/orders', ordersRoutes);   // lifecycle, chat, reviews (must be before paymentsRoutes' /orders/:id)
app.use('/api', usersRoutes);           // /api/users/:username, /api/my/*, /api/favorites/*
app.use('/api', dmRoutes);              // /api/traders, /api/dm/*, block/report, /api/my/privacy
app.use('/api', offersRoutes);          // /api/listings/:id/offers, /api/offers/:id/*, /api/my/offers
app.use('/api', topupsRouter);          // /api/topup/* — add funds to balance
app.use('/api', tradesRouter);          // /api/trades/*, /api/mm/* — in-game trading + middlemen
app.use('/api', tournamentsRouter);     // /api/tournaments/* — community tournaments
app.use('/api', proRouter);             // /api/pro/* — Vault Pro subscriptions
app.use('/api', communityRouter);       // /api/wanted, /api/game-stats, /api/rooms/*
app.use('/api', lobbiesRouter);         // /api/lobbies/* — play-together lobbies + voice
app.use('/api', trustRouter);           // /api/trust/* — scammer watchlist / trust check
app.use('/api', chainsRouter);          // /api/chains/* — multi-person trade chains
app.use('/api', eventsRouter);          // /api/events/* — trade-up events
app.use('/api', keysRouter);            // /api/keys — developer API key management (session)
app.use('/api/v1', v1Router);           // /api/v1/* — developer API (key-authed commands)
app.use('/api/uploads', uploadsRoutes); // image uploads for listings/auctions
app.use('/api/admin', adminRoutes);
app.use('/api', paymentsRoutes); // /api/auctions/:id/checkout/*, /api/listings/:id/checkout/*
app.use('/webhooks', webhooksRouter); // /webhooks/nowpayments (stripe handled above)

// ---- Uploaded item images ----
// Served from the database (durable across redeploys); the static directory
// remains as a fallback for anything not yet imported.
app.get('/uploads/:name', uploadsRoutes.serveImage);
app.use('/uploads', express.static(config.uploadDir));
app.use('/uploads', (req, res) => res.status(404).json({ error: 'Image not found.' }));

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
startTicketRotator(); // rotate middleman tickets that hit the 2-min window
tournamentsRouter.startTournamentJob(); // flip tournaments live when signups close
startProRenewJob(); // renew lapsed Pro subscriptions from site balance (hourly)
lobbiesRouter.startLobbyJob(); // auto-close idle lobbies

app.listen(config.port, () => {
  console.log(`Vault backend listening on http://localhost:${config.port}`);
});
