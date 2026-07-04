require('dotenv').config();

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: required('BASE_URL', 'http://localhost:3000'),
  sessionSecret: required('SESSION_SECRET', 'dev-secret-change-me'),
  isProd: process.env.NODE_ENV === 'production',
  platformFeeBps: parseInt(process.env.PLATFORM_FEE_BPS || '600', 10), // 600 = 6.00%
  // 'added'    -> buyer pays price + fee, seller receives the full price (default)
  // 'deducted' -> buyer pays the price, fee comes out of the seller's proceeds
  feeMode: process.env.FEE_MODE === 'deducted' ? 'deducted' : 'added',
  // Automatic crypto payouts. When true (default), a crypto withdrawal within
  // the caps below fires the NOWPayments payout immediately with no admin click.
  // Over a cap, or any failure, it drops to the manual queue instead.
  autoPayout: process.env.AUTO_PAYOUT !== '0',
  autoPayoutMaxCents: parseInt(process.env.AUTO_PAYOUT_MAX_CENTS || '20000', 10),        // per withdrawal ($200)
  autoPayoutDailyCapCents: parseInt(process.env.AUTO_PAYOUT_DAILY_CAP_CENTS || '50000', 10), // per user / 24h ($500)

  // Content moderation on user-authored text (listings, auctions, chat, bios).
  // On by default; set MODERATION=0 to disable. Extend the word lists with
  // MOD_BLOCKLIST / MOD_MASKLIST (comma-separated). See lib/moderation.js.
  moderationEnabled: process.env.MODERATION !== '0',

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: required('DISCORD_REDIRECT_URI', 'http://localhost:3000/auth/discord/callback'),
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  nowpayments: {
    apiKey: process.env.NOWPAYMENTS_API_KEY,
    ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
    apiBase: required('NOWPAYMENTS_API_BASE', 'https://api.nowpayments.io/v1'),
    // For AUTOMATED PAYOUTS (optional). Payout API needs account credentials
    // (JWT auth) on top of the API key, plus your 2FA secret so the server
    // can generate the verification code itself.
    email: process.env.NOWPAYMENTS_EMAIL,
    password: process.env.NOWPAYMENTS_PASSWORD,
    twoFaSecret: process.env.NOWPAYMENTS_2FA_SECRET,
  },
};
