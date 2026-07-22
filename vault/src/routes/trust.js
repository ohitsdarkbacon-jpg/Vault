// Trust Check / scammer watchlist — look up a Discord username before you trade.
// Anyone can file a report (or a vouch) against a username; admins set a
// verified verdict. A username with open scam reports is auto-"flagged" until
// an admin confirms (scammer) or clears (trusted) it.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { moderateField } = require('../lib/moderation');

const router = express.Router();

const STATUSES = ['clean', 'flagged', 'scammer', 'trusted'];
const MAX_DETAIL = 600;
// Discord usernames: 2–32 chars of letters/digits/._ , with an optional
// legacy #0000 discriminator (e.g. "scammer.99" or "Scammer#1234").
const USERNAME_RE = /^[A-Za-z0-9._]{2,32}(#[0-9]{1,4})?$/;

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only.' });
  next();
}
function validUrl(url) {
  if (!url) return true;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

// Report tallies + the resolved public verdict for one profile.
function tallies(profileId) {
  const row = db
    .prepare(
      `SELECT
        SUM(CASE WHEN kind = 'scam' AND status = 'open' THEN 1 ELSE 0 END) AS scam_reports,
        SUM(CASE WHEN kind = 'safe' AND status = 'open' THEN 1 ELSE 0 END) AS vouches
       FROM trust_reports WHERE profile_id = ?`
    )
    .get(profileId);
  return { scam_reports: row.scam_reports || 0, vouches: row.vouches || 0 };
}

// Shape a profile row for the client, including its reports.
function profileView(p, { withReports = false } = {}) {
  const t = tallies(p.id);
  const out = {
    id: p.id,
    username: p.username,
    status: p.status,
    admin_note: p.admin_note || null,
    reviewed_at: p.reviewed_at || null,
    scam_reports: t.scam_reports,
    vouches: t.vouches,
    updated_at: p.updated_at,
  };
  if (withReports) {
    out.reports = db
      .prepare(
        `SELECT r.id, r.kind, r.detail, r.evidence_url, r.created_at, u.username AS reporter, r.status
         FROM trust_reports r JOIN users u ON u.id = r.reporter_id
         WHERE r.profile_id = ? AND r.status = 'open' ORDER BY r.id DESC`
      )
      .all(p.id);
  }
  return out;
}

function getProfileByName(username) {
  return db.prepare('SELECT * FROM trust_profiles WHERE username_key = ?').get(username.toLowerCase());
}

// ---------- Lookup (public) ----------
router.get('/trust/lookup', (req, res) => {
  const username = String(req.query.u || '').trim();
  if (!username) return res.status(400).json({ error: 'Enter a username to check.' });
  if (!USERNAME_RE.test(username)) {
    return res.json({ username, profile: null, invalid: true });
  }
  const p = getProfileByName(username);
  if (!p) return res.json({ username, profile: null });
  res.json({ username, profile: profileView(p, { withReports: true }) });
});

// ---------- Watchlist (public) ----------
// Confirmed scammers and the most-reported accounts, worst first.
router.get('/trust/watchlist', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM trust_reports r WHERE r.profile_id = p.id AND r.kind = 'scam' AND r.status = 'open') AS scam_reports
       FROM trust_profiles p
       WHERE p.status IN ('scammer','flagged')
          OR EXISTS (SELECT 1 FROM trust_reports r WHERE r.profile_id = p.id AND r.kind = 'scam' AND r.status = 'open')
       ORDER BY CASE p.status WHEN 'scammer' THEN 0 WHEN 'flagged' THEN 1 ELSE 2 END,
                scam_reports DESC, p.updated_at DESC
       LIMIT 100`
    )
    .all();
  res.json({ items: rows.map((p) => profileView(p)) });
});

// ---------- File a report / vouch (auth) ----------
router.post('/trust/report', requireAuth, (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Enter a valid Discord username (2–32 characters — letters, numbers, . or _).' });
  const kind = b.kind === 'safe' ? 'safe' : 'scam';
  const detail = String(b.detail || '').trim();
  if (detail.length < 10) return res.status(400).json({ error: 'Please describe what happened (at least 10 characters).' });
  if (detail.length > MAX_DETAIL) return res.status(400).json({ error: `Keep it under ${MAX_DETAIL} characters.` });
  const evidence_url = b.evidence_url ? String(b.evidence_url).trim() : null;
  if (!validUrl(evidence_url)) return res.status(400).json({ error: 'Evidence link must be an http(s) URL.' });
  const mod = moderateField(detail, 'report');
  if (!mod.ok) return res.status(400).json({ error: mod.error });

  const result = db.transaction(() => {
    let p = getProfileByName(username);
    if (!p) {
      const info = db
        .prepare("INSERT INTO trust_profiles (username, username_key) VALUES (?, ?)")
        .run(username, username.toLowerCase());
      p = db.prepare('SELECT * FROM trust_profiles WHERE id = ?').get(info.lastInsertRowid);
    }
    try {
      db.prepare(
        'INSERT INTO trust_reports (profile_id, reporter_id, kind, detail, evidence_url) VALUES (?, ?, ?, ?, ?)'
      ).run(p.id, req.user.id, kind, mod.clean, evidence_url);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return { error: "You've already reported this username." };
      throw e;
    }
    // Auto-flag a scam report on a not-yet-reviewed profile.
    if (kind === 'scam' && p.status === 'clean') {
      db.prepare("UPDATE trust_profiles SET status = 'flagged', updated_at = datetime('now') WHERE id = ?").run(p.id);
    } else {
      db.prepare("UPDATE trust_profiles SET updated_at = datetime('now') WHERE id = ?").run(p.id);
    }
    return { id: p.id };
  })();

  if (result.error) return res.status(409).json({ error: result.error });
  const p = db.prepare('SELECT * FROM trust_profiles WHERE id = ?').get(result.id);
  res.status(201).json({ ok: true, profile: profileView(p, { withReports: true }) });
});

// ---------- Admin: set verdict ----------
router.post('/admin/trust/:id/status', requireAuth, requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM trust_profiles WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Profile not found.' });
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  let note = req.body?.admin_note ? String(req.body.admin_note).trim().slice(0, 200) : null;
  if (note) {
    const mod = moderateField(note, 'note');
    if (!mod.ok) return res.status(400).json({ error: mod.error });
    note = mod.clean;
  }
  db.prepare(
    "UPDATE trust_profiles SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(status, note, req.user.id, p.id);
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'trust_status', `${p.username} → ${status}`); } catch (_) {}
  const updated = db.prepare('SELECT * FROM trust_profiles WHERE id = ?').get(p.id);
  res.json({ ok: true, profile: profileView(updated, { withReports: true }) });
});

// ---------- Admin: dismiss a false report ----------
router.delete('/admin/trust/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM trust_reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Report not found.' });
  db.prepare("UPDATE trust_reports SET status = 'dismissed' WHERE id = ?").run(r.id);
  // If a flagged profile has no open scam reports left, drop it back to clean.
  const p = db.prepare('SELECT * FROM trust_profiles WHERE id = ?').get(r.profile_id);
  if (p && p.status === 'flagged') {
    const { n } = db.prepare("SELECT COUNT(*) n FROM trust_reports WHERE profile_id = ? AND kind = 'scam' AND status = 'open'").get(p.id);
    if (!n) db.prepare("UPDATE trust_profiles SET status = 'clean', updated_at = datetime('now') WHERE id = ?").run(p.id);
  }
  try { db.prepare('INSERT INTO admin_log (admin_id, action, detail) VALUES (?, ?, ?)').run(req.user.id, 'trust_report_dismissed', String(r.id)); } catch (_) {}
  res.json({ ok: true });
});

module.exports = router;
