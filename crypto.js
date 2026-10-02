'use strict';
const crypto = require('node:crypto');
const env = require('./env');

// ---------- Password hashing (scrypt, salted) ----------
// Format stored in DB: scrypt$<saltHex>$<hashHex>
function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plainPassword, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(plainPassword, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(plainPassword, salt, 64, { N: 16384, r: 8, p: 1 });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ---------- Signed session tokens (HMAC-SHA256, stateless-verifiable) ----------
// payload is a plain object; token = base64url(json) + "." + hmac
function signSession(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256Hex, signSession, verifySession };
