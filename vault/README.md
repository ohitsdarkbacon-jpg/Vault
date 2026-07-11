# Vault — Roblox trading marketplace with escrow

Express + SQLite marketplace for Roblox items with **escrow-protected settlement**:
buyers pay by card (Stripe), crypto (NOWPayments), or site credit; the money is
held by the platform until the buyer confirms delivery in Roblox. Includes
auctions with anti-sniping, per-order chat, seller ratings, a full user dashboard,
withdrawals, notifications, public profiles, and an admin panel.

## Features

**Trading**
- Fixed-price listings + timed auctions (bid history, min increments, anti-snipe: bids in the last 2 min extend the auction 2 min)
- **Game categories** (Adopt Me, Blox Fruits, MM2, Grow a Garden, Steal a Brainrot, Pet Sim 99, Da Hood) with one-tap filter chips on both browse sections and tags on item cards — Vault is for real-money trades of in-game items, not Robux-purchasable limiteds
- **🔥 Most watched** trending strip on the home page (ranked by watcher count)
- **Profile achievements**: auto-earned badges — 🤝 First Trade, 💼 Power Seller, 🌟 Top Rated, 🐋 Big Fish ($100+ trade), 🏛 Vault Veteran
- **Offers / negotiation**: buyers make offers below asking price; sellers accept, decline, or counter; an accepted offer becomes that buyer's checkout price on every payment rail. When the item sells, all other offers auto-expire with a notification
- **⚡ Buy It Now on auctions**: optional buyout price ends the auction instantly for the buyer (bids at/above it are redirected to the buyout)
- **Edit listings** in place (title/description/image/price) — price cuts ping everyone watching with a 📉 price-drop notification
- **⏰ Ending-soon alerts**: watchers and the high bidder get notified when an auction they care about enters its final hour
- Live-updating countdowns, quick-bid chips (min / +1 step / +5 steps), share links with deep-linking (`#listing-N` / `#auction-N`)
- Recently-traded strip on the home page for social proof
- Item images are **required** on every listing/auction: upload, **paste a screenshot (Ctrl+V)**, or **drag & drop** straight into the sell modal — PNG/JPG/GIF/WEBP/BMP/AVIF up to 20 MB (SVG excluded as an XSS vector). Click any item image for a full-size lightbox
- Full-text search (SQLite FTS5 with LIKE fallback), price filters, sorting, pagination
- Favorites / watchlist

**Money (the important part)**
- Checkout via Stripe (card), NOWPayments (BTC/ETH/USDT/LTC/SOL), or site credit
- **Add funds**: top up your balance ($5–$1,000) by card or crypto from the Wallet tab — credited automatically via webhook, with a polling fallback
- Crypto checkout shows a **live transaction tracker** (awaiting deposit → confirming on-chain → in escrow), fed by the NOWPayments status API with partial-payment detection
- **Double-sell protection**: if two buyers pay for the same item in a race, the first payment wins and the second is automatically refunded as site credit
- **Escrow**: payment is held until the buyer confirms receipt → then the seller's balance is credited (minus the fee, default 6%, `PLATFORM_FEE_BPS`)
- Auto-release 72h after the seller marks delivered (`AUTO_COMPLETE_HOURS`) unless the buyer disputes
- Disputes freeze funds; admins refund the buyer or release to the seller
- Withdrawals: sellers request PayPal/crypto payouts into an admin queue
- **One-click automated crypto payouts** via the NOWPayments Mass Payouts API — admin hits ⚡, the server authenticates (JWT + auto-generated 2FA/TOTP code), NOWPayments sends crypto from your balance to the seller's wallet, and the IPN webhook flips the withdrawal to Paid when the transfer confirms. PayPal stays manual.
- **Fee modes** (`FEE_MODE`): `added` (default — buyer pays price + 6% at checkout, seller keeps 100% of the price) or `deducted` (classic: fee comes out of seller proceeds)

**In-game trading (item-for-item, no money)**
- **Trade board** (`#trading`): post what you HAVE ⇄ what you WANT (e.g. Shadow Dragon for Strawberry Elephant), tagged by game, searchable; interested traders DM you
- **Middleman network**: anyone can apply, admins approve/reject/revoke from the panel
- **Middleman tickets** (optional — you can always trade directly in game): once two traders match, either party requests a ticket (the partner auto-fills when you're on their post). A random **online** middleman is auto-assigned; if they don't respond within **2 minutes** the ticket rotates to the next online middleman, and if nobody's left it goes unavailable with a notification. Middlemen accept/pass from their dashboard, coordinate via DMs, and mark the trade completed.
- **Optional middleman tips**: promise a gratitude tip when requesting a ticket — purely informational, nothing is held or charged by the platform. The middleman sees it with the assignment, and the requester gets a friendly reminder to send it when the ticket completes.

**Community & trust**
- Per-order buyer↔seller chat (coordinate the in-game trade; admins can read it during disputes)
- **Direct messages**: message any trader on the site — conversation inbox with unread badges, live polling, online status
- **Trader directory** (`#traders`): browse/search every trader with ratings, sales, and online indicators
- **Profile privacy**: hide your profile — you vanish from the directory and your profile page goes private (existing DM threads stay open; your listings stay on the marketplace)
- **Block users** (they can't DM you, you can't DM them) and **report users** to moderators
- Online presence: last-seen tracking with an "online" dot (active in the last 5 min)
- **Two-way reviews**: after a completed order, the buyer rates the seller AND the seller rates the buyer (1–5★ + comment, moderated). Profiles show a star-breakdown histogram, per-review role chips ("bought from them" / "sold to them"), and the reviewed party can post one public reply
- Public profiles: rating, completed sales, member since, bio, live inventory
- In-app notifications: outbid, auction won/sold, item sold, delivered, completed, disputed, refunded, new message, DMs, withdrawal, moderation

**Admin panel** (`#admin`, for users in `ADMIN_DISCORD_IDS`)
- Live stats incl. money held in escrow + fees earned + open reports
- Dispute resolution, withdrawal queue, user search + ban/unban
- **Reports tab**: review user reports and mark them resolved
- **✔ Verified trader badges**: grant/revoke a trust badge shown next to the user's name site-wide
- **Content tab**: browse/search live listings & auctions and take any of them down (seller + bidders are notified)
- Grant or deduct **site credit** on any account (including your own) from the Users tab

**Content moderation**
- User-authored text (listing/auction titles + descriptions, order chat, profile bios) runs through a filter: hate slurs and other hard-blocked terms are rejected on submit; ordinary profanity is starred out (`f***`). Matching is done on a normalized copy so leetspeak/spacing (`n1gger`, `f a g`) doesn't slip through, while it stays clear of false positives (`peacock`, `classic`, `assassin` are left alone).
- On by default. `MODERATION=0` disables it; `MOD_BLOCKLIST` / `MOD_MASKLIST` (comma-separated) extend the built-in lists. See `src/lib/moderation.js`.

## Stack
- Node.js 18+ / Express, SQLite (better-sqlite3, with automatic fallback to Node's built-in `node:sqlite` if the native module can't build)
- Cookie sessions, Discord OAuth 2.0 (PKCE), Stripe Checkout, NOWPayments IPN
- Vanilla JS single-page frontend (no build step)

## 1. Local setup

```bash
npm install
cp .env.example .env   # then fill it in (see the comments in that file)
npm start              # or: npm run dev
```

Visit `http://localhost:3000`. The DB schema (including all v2 tables) is created/migrated automatically on boot.

**Testing locally without Discord OAuth:** set `DEV_LOGIN=1` in `.env`, then
`curl -XPOST localhost:3000/auth/dev-login -H 'Content-Type: application/json' -d '{"username":"me"}'`
(or from the browser console: `fetch('/auth/dev-login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"username":"me"}'}).then(()=>location.reload())`).
**Never enable DEV_LOGIN in production.**

## 2. Deploy on Railway

1. Push this folder to a GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo. Nixpacks auto-detects Node; `railway.json` runs `npm start`.
3. **Add a Volume**: service → *Volumes* → *New Volume*, mount path `/data`. Required — without it the SQLite DB is wiped on every redeploy.
4. Set *Variables* (same keys as `.env.example`):
   - `DB_PATH=/data/vault.db`
   - `UPLOAD_DIR=/data/uploads` (so uploaded item images survive redeploys — same volume as the DB; omit and uploads default to `public/uploads`, which is wiped on redeploy)
   - `BASE_URL=https://<your-app>.up.railway.app` — must be your **public** URL. It's normalized automatically (bare domains get `https://`, trailing slashes stripped). If it isn't publicly reachable (e.g. localhost in dev), crypto payments are created **without** an IPN callback and orders confirm via status polling instead — slower but fully functional.
   - `SESSION_SECRET` → generate: `openssl rand -hex 32`
   - `NODE_ENV=production`
   - `ADMIN_DISCORD_IDS=<your Discord user ID>` (comma-separate for multiple admins; admin flag is applied at boot after each admin has signed in once)
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI=<BASE_URL>/auth/discord/callback`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `NOWPAYMENTS_API_BASE=https://api.nowpayments.io/v1`
   - Do **not** set `PORT` (Railway injects it) and do **not** set `DEV_LOGIN`.
5. Point the external services at your Railway URL:
   - Discord OAuth app ([discord.com/developers/applications](https://discord.com/developers/applications) → OAuth2) → add redirect → `<BASE_URL>/auth/discord/callback`
   - Stripe → webhooks → add endpoint `<BASE_URL>/webhooks/stripe`, event `checkout.session.completed` → copy the signing secret into `STRIPE_WEBHOOK_SECRET`
   - NOWPayments: IPN callback URL is sent automatically per-payment, nothing to configure
6. Redeploy after setting variables.
7. Sign in with your own Discord account once, then redeploy (or restart) so the `ADMIN_DISCORD_IDS` seeding marks you admin — the 🛡 Admin item appears in your avatar menu.

## Automated payouts setup (NOWPayments)

1. On nowpayments.io: activate your Custody balance, **enable 2FA** and save the base32 secret (the text version of the QR code), and whitelist your server IP if their dashboard asks for it.
2. Set `NOWPAYMENTS_EMAIL`, `NOWPAYMENTS_PASSWORD`, `NOWPAYMENTS_2FA_SECRET` on Railway.
3. Keep your NOWPayments balance funded — payouts draw from it. Incoming crypto sales already land there, so normally it self-funds; top it up if card sales outpace crypto ones.
4. **Payouts are automatic by default.** When a seller requests a crypto withdrawal that's within both risk caps, the payout fires immediately — created and 2FA-verified server-side, then marked **Paid** by the IPN callback when the transfer confirms on-chain. No admin action.

### Risk caps (the throttle that replaces manual approval)
- `AUTO_PAYOUT_MAX_CENTS` — max auto-paid per single withdrawal (default $200)
- `AUTO_PAYOUT_DAILY_CAP_CENTS` — max auto-paid per user per rolling 24h (default $500)
- A withdrawal over **either** cap, or **any** payout API failure, drops to the manual admin queue instead — it's never stuck, and a human decides. Set `AUTO_PAYOUT=0` to require an admin click for every payout (the old behavior).
- In Admin → Withdrawals you'll only see PayPal payouts, over-cap crypto, and anything that failed. Crypto rows there still have a ⚡ "Send via NOWPayments" button to retry manually.

These caps mean a buyer paying with a stolen card can only pull small amounts through irreversible crypto before hitting the manual queue, where you can catch it.

If the three env vars are unset, the button disappears and everything falls back to the manual mark-sent flow. Sellers pick their payout coin (USDT TRC20/ERC20, BTC, ETH, LTC, SOL) and address when requesting a withdrawal.

## How money moves

```
buyer pays price + 6% buyer fee (card/crypto/credit)
        │ webhook / instant
        ▼
order: paid  ──────────────► money sits in ESCROW (seller can see it, can't touch it)
        │ seller delivers in Roblox, clicks "Mark delivered"
        ▼
order: delivered
        │ buyer clicks "Confirm receipt"        │ 72h pass, no dispute
        ▼                                       ▼
order: completed  ◄─────────────────────────────┘
        seller balance += full price (fee was added on top at checkout)
        │ seller requests withdrawal → admin queue
        │    crypto: ⚡ one click → NOWPayments sends it → auto-marked Paid
        │    paypal: you send it manually → mark sent
```

A dispute at any point before release freezes the order; an admin reads the
order chat and either refunds the buyer (as site credit; listing re-opens) or
releases to the seller.

## API surface (summary)

```
Auth:      GET /auth/discord/login|callback · POST /auth/logout · GET /api/me · GET /api/stats
Listings:  GET/POST /api/listings · GET /api/listings/:id · POST /api/listings/:id/buy-with-credit|checkout/stripe|checkout/crypto|cancel
Auctions:  GET/POST /api/auctions · GET /api/auctions/:id · GET /api/auctions/:id/bids · POST /api/auctions/:id/bid|cancel|checkout/*
Orders:    GET /api/orders/:id · POST /api/orders/:id/delivered|confirm|dispute|review · GET/POST /api/orders/:id/messages
Me:        GET /api/my/overview|purchases|sales|listings|bids|favorites|withdrawals|notifications
           POST /api/my/withdrawals · POST /api/my/notifications/read · POST /api/my/bio · POST /api/favorites/toggle
Uploads:   POST /api/uploads (multipart image → { url }); files served at /uploads/*
Profiles:  GET /api/users/:username
Admin:     GET /api/admin/overview|disputes|withdrawals|users|listings
           POST /api/admin/disputes/:id/resolve · /api/admin/withdrawals/:id · /api/admin/users/:id/ban|unban|credit · /api/admin/{listings,auctions}/:id/remove
Webhooks:  POST /webhooks/stripe · POST /webhooks/nowpayments
```

## Things to know before going live

- **Roblox ToS**: real-money trading of Roblox items is against Roblox's Terms of Service (Roblox requires trades to settle in Robux through their systems). Accounts involved can be banned by Roblox. This is a policy/business decision you should make with eyes open before launching publicly.
- Refunds on disputes are issued as **site credit**, not back to the card/chain. If you want true Stripe refunds, wire `stripe.refunds.create` into `refundOrder()`.
- Crypto payouts are automated (see above) but still admin-triggered on purpose — a human approves every payout, so a bug or hijacked account can't drain your balance silently. PayPal payouts remain manual.
- Single-instance assumptions: the auction closer + auto-complete jobs and SQLite itself assume one server process. That's exactly what one Railway service gives you — don't scale to multiple replicas without moving to Postgres + a worker.
- Basic profanity/slur filtering now runs on listings, auctions, chat, and bios (see **Content moderation** above) — it's a word-list filter, not a full context-aware moderation service. Uploaded images are stored on disk (`UPLOAD_DIR`) and served from `/uploads`; external image URLs are still allowed and validated but not proxied/re-hosted. Uploads are size- and MIME-checked but not virus/content-scanned.
- Rate limits exist (global writes, bids, chat) but you may want stricter per-user limits at scale.
