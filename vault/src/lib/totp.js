const crypto = require('crypto');

/**
 * RFC 6238 TOTP — generates the same 6-digit codes as Google Authenticator,
 * so the server can pass NOWPayments' payout 2FA check without a human.
 * No dependencies: base32-decode the shared secret, HMAC-SHA1 the time step,
 * dynamic-truncate.
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in 2FA secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, { period = 30, digits = 6, timestamp = Date.now() } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    10 ** digits;
  return String(code).padStart(digits, '0');
}

module.exports = { totp };
