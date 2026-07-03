const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');
const config = require('../config');

const router = express.Router();

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Builds a Discord CDN avatar URL from the user object Discord returns.
function discordAvatarUrl(u) {
  if (u.avatar) {
    const ext = u.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=128`;
  }
  // Default avatar: new usernames use (id >> 22) % 6, legacy use discriminator % 5
  let index = 0;
  if (u.discriminator && u.discriminator !== '0') {
    index = parseInt(u.discriminator, 10) % 5;
  } else {
    try { index = Number((BigInt(u.id) >> 22n) % 6n); } catch (_) { index = 0; }
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Prefers the new global display name, falls back to username (+ discriminator for legacy accounts).
function discordDisplayName(u) {
  if (u.global_name) return u.global_name;
  if (u.discriminator && u.discriminator !== '0') return `${u.username}#${u.discriminator}`;
  return u.username;
}

// Step 1: kick off "Sign in with Discord" (Authorization Code + PKCE)
router.get('/discord/login', (req, res) => {
  if (!config.discord.clientId) {
    return res.status(500).send('Discord OAuth is not configured on this server yet.');
  }
  const state = base64url(crypto.randomBytes(16));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  req.session.oauthState = state;
  req.session.oauthVerifier = verifier;

  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  });

  res.redirect(`${config.discord.authorizeUrl}?${params.toString()}`);
});

// Step 2: Discord redirects back here with ?code=&state=
router.get('/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?auth_error=' + encodeURIComponent(String(error)));
  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?auth_error=invalid_state');
  }
  const verifier = req.session.oauthVerifier;
  req.session.oauthState = null;
  req.session.oauthVerifier = null;

  try {
    const tokenResp = await axios.post(
      config.discord.tokenUrl,
      new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.discord.redirectUri,
        code_verifier: verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenResp.data;

    const userinfoResp = await axios.get(config.discord.userinfoUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const u = userinfoResp.data; // { id, username, global_name, discriminator, avatar, ... }

    const providerId = String(u.id);
    const displayName = discordDisplayName(u);
    const avatar = discordAvatarUrl(u);

    let user = db.prepare('SELECT * FROM users WHERE provider_id = ?').get(providerId);
    if (!user) {
      const info = db
        .prepare('INSERT INTO users (provider_id, username, avatar_url) VALUES (?, ?, ?)')
        .run(providerId, displayName || `user_${providerId}`, avatar || null);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(
        displayName || user.username,
        avatar || user.avatar_url,
        user.id
      );
    }

    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('Discord OAuth error:', err.response?.data || err.message);
    res.redirect('/?auth_error=oauth_failed');
  }
});

// DEV ONLY: instant login without Discord OAuth. Hard-disabled unless the
// DEV_LOGIN=1 env var is set — never set that in production.
router.post('/dev-login', (req, res) => {
  if (process.env.DEV_LOGIN !== '1') return res.status(404).json({ error: 'Not found.' });
  const username = String(req.body?.username || '').trim() || 'dev_user';
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    const info = db
      .prepare('INSERT INTO users (provider_id, username) VALUES (?, ?)')
      .run('dev_' + username, username);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  req.session.userId = user.id;
  res.json({ user });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

module.exports = router;
