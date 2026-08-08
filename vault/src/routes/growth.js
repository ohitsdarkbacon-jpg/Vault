// Growth: the referral programme, the creator partner programme, and the
// admin controls for feature flags.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { moderateField } = require('../lib/moderation');
const { notify, notifyAdmins } = require('../lib/notify');
const { codeFor, statsFor, VANITY_RE, userByCode } = require('../lib/referrals');
const { requireFlag, allFlags, setFlag } = require('../lib/flags');

const router = express.Router();

const PLATFORMS = ['youtube', 'tiktok', 'twitch', 'x', 'discord', 'other'];
const MAX_PITCH = 800;

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  next();
}
function validUrl(url) {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}
const inviteLink = (code) => `${config.baseUrl}/?ref=${encodeURIComponent(code)}`;

// ============================================================
// Referrals
// ============================================================

// My invite code, link, stats and the people I've brought in.
router.get('/my/referrals', requireAuth, requireFlag('referrals'), (req, res) => {
  const code = codeFor(req.user.id);
  const invited = db
    .prepare(
      `SELECT u.username, u.avatar_url, r.status, r.referrer_reward_cents, r.referrer_pro_days,
              r.created_at, r.qualified_at
       FROM referrals r JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = ? ORDER BY r.id DESC LIMIT 100`
    )
    .all(req.user.id);
  res.json({
    code,
    link: inviteLink(code),
    stats: statsFor(req.user.id),
    invited,
    rewards: {
      signup_pro_days: config.referralSignupProDays, // both sides, instantly
      referrer_cents: config.referralReferrerRewardCents,
      referred_cents: config.referralSignupBonusCents,
      pro_days_cap: config.referralMaxSignupProDays,
    },
    can_customize: !!req.user.is_creator, // vanity codes are a creator perk
  });
});

// Approved creators can claim a memorable vanity code for their audience.
router.post('/my/referral-code', requireAuth, requireFlag('referrals'), (req, res) => {
  if (!req.user.is_creator) {
    return res.status(403).json({ error: 'Custom invite codes are a creator-partner perk — apply from the Creators page.' });
  }
  const desired = String(req.body?.code || '').trim();
  if (!VANITY_RE.test(desired)) {
    return res.status(400).json({ error: 'Codes are 3–20 characters: letters, numbers, - or _.' });
  }
  const mod = moderateField(desired, 'code');
  if (!mod.ok) return res.status(400).json({ error: mod.error });
  const taken = userByCode(desired);
  if (taken && taken.id !== req.user.id) return res.status(409).json({ error: 'That code is already taken.' });
  db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(desired, req.user.id);
  res.json({ ok: true, code: desired, link: inviteLink(desired) });
});

// Public leaderboard — only qualified referrals count, so it can't be gamed
// by mass-spamming signups that never trade.
router.get('/referrals/leaderboard', requireFlag('referrals'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.username, u.avatar_url, u.is_creator,
        COUNT(*) AS invites,
        (u.pro_until IS NOT NULL AND julianday(u.pro_until) > julianday('now')) AS pro
       FROM referrals r JOIN users u ON u.id = r.referrer_id
       WHERE r.status = 'qualified' AND u.is_banned = 0 AND u.profile_hidden = 0
       GROUP BY r.referrer_id ORDER BY invites DESC, MIN(r.qualified_at) ASC LIMIT 20`
    )
    .all();
  res.json({ leaders: rows });
});

// ============================================================
// Creator partner programme
// ============================================================

router.post('/creator/apply', requireAuth, requireFlag('creators'), (req, res) => {
  const b = req.body || {};
  const platform = PLATFORMS.includes(b.platform) ? b.platform : null;
  if (!platform) return res.status(400).json({ error: 'Pick a platform.' });
  const handle = String(b.handle || '').trim().slice(0, 60);
  if (!handle) return res.status(400).json({ error: 'What handle do you post under?' });
  const url = String(b.url || '').trim();
  if (!validUrl(url)) return res.status(400).json({ error: 'Add a link to your channel or profile (http/https).' });
  const followers = parseInt(b.followers, 10);
  if (!Number.isInteger(followers) || followers < 0) return res.status(400).json({ error: 'Enter your follower/subscriber count.' });
  const pitch = b.pitch ? String(b.pitch).trim().slice(0, MAX_PITCH) : null;

  const modHandle = moderateField(handle, 'handle');
  if (!modHandle.ok) return res.status(400).json({ error: modHandle.error });
  const modPitch = moderateField(pitch, 'pitch');
  if (!modPitch.ok) return res.status(400).json({ error: modPitch.error });

  const open = db.prepare("SELECT 1 FROM creator_applications WHERE user_id = ? AND status = 'pending'").get(req.user.id);
  if (open) return res.status(409).json({ error: 'You already have an application under review.' });
  if (req.user.is_creator) return res.status(409).json({ error: "You're already a Vault creator partner. 🎉" });

  const info = db
    .prepare('INSERT INTO creator_applications (user_id, platform, handle, url, followers, pitch) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, platform, modHandle.clean, url, followers, modPitch.clean || null);
  notifyAdmins('creator_app', `🎬 ${req.user.username} applied to the creator programme (${platform}, ${followers.toLocaleString()} followers).`, '#admin');
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
});

// My application status (drives the Creators page CTA).
router.get('/creator/me', requireAuth, requireFlag('creators'), (req, res) => {
  const app = db
    .prepare('SELECT id, platform, handle, url, followers, status, admin_note, created_at, reviewed_at FROM creator_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(req.user.id);
  res.json({
    application: app || null,
    is_creator: !!req.user.is_creator,
    creator: req.user.is_creator
      ? { platform: req.user.creator_platform, handle: req.user.creator_handle, url: req.user.creator_url }
      : null,
  });
});

// Public directory of approved partners — free promo for them, social proof
// for the site.
router.get('/creators', requireFlag('creators'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT username, avatar_url, creator_platform AS platform, creator_handle AS handle,
              creator_url AS url, referral_code,
              (pro_until IS NOT NULL AND julianday(pro_until) > julianday('now')) AS pro
       FROM users WHERE is_creator = 1 AND is_banned = 0 ORDER BY username COLLATE NOCASE`
    )
    .all();
  res.json({ creators: rows });
});

// ---------- Admin review ----------
router.get('/admin/creator-applications', requireAuth, requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db
    .prepare(
      `SELECT a.*, u.username, u.avatar_url,
        (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = a.user_id AND r.status = 'qualified') AS qualified_referrals
       FROM creator_applications a JOIN users u ON u.id = a.user_id
       WHERE a.status = ? ORDER BY a.id DESC LIMIT 100`
    )
    .all(status);
  res.json({ applications: rows });
});

router.post('/admin/creator-applications/:id/review', requireAuth, requireAdmin, (req, res) => {
  const app = db.prepare('SELECT * FROM creator_applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found.' });
  if (app.status !== 'pending') return res.status(400).json({ error: 'This application was already reviewed.' });
  const decision = req.body?.decision;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  let note = req.body?.note ? String(req.body.note).trim().slice(0, 300) : null;
  if (note) {
    const mod = moderateField(note, 'note');
    if (!mod.ok) return res.status(400).json({ error: mod.error });
    note = mod.clean;
  }

  db.transaction(() => {
    db.prepare("UPDATE creator_applications SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(decision, note, req.user.id, app.id);
    if (decision === 'approved') {
      db.prepare('UPDATE users SET is_creator = 1, creator_platform = ?, creator_handle = ?, creator_url = ? WHERE id = ?')
        .run(app.platform, app.handle, app.url, app.user_id);
    }
  })();

  notify(
    app.user_id,
    'creator_app',
    decision === 'approved'
      ? '🎬 You were approved as a Vault creator partner! You now have a creator badge, a custom invite code, and a spot in the creator directory.'
      : `Your creator application wasn't approved this time.${note ? ' Note: ' + note : ''}`,
    '#creators'
  );
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'creator_' + decision, app.handle); } catch (_) {}
  res.json({ ok: true });
});

// Admin can revoke partner status later (e.g. inactive or ToS break).
router.post('/admin/creators/:username/revoke', requireAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  db.prepare('UPDATE users SET is_creator = 0 WHERE id = ?').run(u.id);
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'creator_revoked', u.username); } catch (_) {}
  res.json({ ok: true });
});

// ============================================================
// Feature flags (admin)
// ============================================================
router.get('/admin/flags', requireAuth, requireAdmin, (req, res) => {
  const flags = allFlags();
  res.json({ flags: Object.entries(flags).map(([key, v]) => ({ key, ...v })).sort((a, b) => a.label.localeCompare(b.label)) });
});

router.post('/admin/flags/:key', requireAuth, requireAdmin, (req, res) => {
  const ok = setFlag(req.params.key, !!req.body?.enabled);
  if (!ok) return res.status(404).json({ error: 'Unknown flag.' });
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'flag_toggled', `${req.params.key} → ${req.body?.enabled ? 'on' : 'off'}`); } catch (_) {}
  res.json({ ok: true });
});

module.exports = router;
