const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../db');
const config = require('../config');

const router = express.Router();

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Step 1: kick off "Sign in with Roblox" (Authorization Code + PKCE)
router.get('/roblox/login', (req, res) => {
  if (!config.roblox.clientId) {
    return res.status(500).send('Roblox OAuth is not configured on this server yet.');
  }
  const state = base64url(crypto.randomBytes(16));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  req.session.oauthState = state;
  req.session.oauthVerifier = verifier;

  const params = new URLSearchParams({
    client_id: config.roblox.clientId,
    redirect_uri: config.roblox.redirectUri,
    scope: 'openid profile',
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`${config.roblox.authorizeUrl}?${params.toString()}`);
});

// Step 2: Roblox redirects back here with ?code=&state=
router.get('/roblox/callback', async (req, res) => {
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
      config.roblox.tokenUrl,
      new URLSearchParams({
        client_id: config.roblox.clientId,
        client_secret: config.roblox.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.roblox.redirectUri,
        code_verifier: verifier,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenResp.data;

    const userinfoResp = await axios.get(config.roblox.userinfoUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    // Typical claims: sub (roblox user id), preferred_username, picture
    const { sub, preferred_username, picture } = userinfoResp.data;

    let user = db.prepare('SELECT * FROM users WHERE roblox_id = ?').get(sub);
    if (!user) {
      const info = db
        .prepare(
          'INSERT INTO users (roblox_id, username, avatar_url) VALUES (?, ?, ?)'
        )
        .run(sub, preferred_username || `user_${sub}`, picture || null);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(
        preferred_username || user.username,
        picture || user.avatar_url,
        user.id
      );
    }

    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('Roblox OAuth error:', err.response?.data || err.message);
    res.redirect('/?auth_error=oauth_failed');
  }
});

// DEV ONLY: instant login without Roblox OAuth. Hard-disabled unless the
// DEV_LOGIN=1 env var is set — never set that in production.
router.post('/dev-login', (req, res) => {
  if (process.env.DEV_LOGIN !== '1') return res.status(404).json({ error: 'Not found.' });
  const username = String(req.body?.username || '').trim() || 'dev_user';
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    const info = db
      .prepare('INSERT INTO users (roblox_id, username) VALUES (?, ?)')
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
