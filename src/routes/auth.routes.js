'use strict';
const { db, uid } = require('../db');
const { hashPassword, verifyPassword, randomToken, sha256Hex, signSession } = require('../lib/crypto');
const { sendJson, readBody, setCookie, clearCookie, getClientIp } = require('../lib/http');
const { recordLoginAttempt, isLoginBlocked, WINDOW_MINUTES } = require('../lib/ratelimit');
const { logAction } = require('../lib/audit');
const { loadUserFromRequest } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');
const env = require('../lib/env');

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    organizationId: u.organizationId,
    organizationName: u.organization ? u.organization.name : null,
    isSuperAdmin: u.isSuperAdmin,
    roles: u.roles,
    permissions: Array.from(u.permissions),
  };
}

function issueSession(res, user) {
  const csrf = randomToken(24);
  const exp = Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000;
  const token = signSession({ uid: user.id, csrf, exp });
  setCookie(res, 'session', token, { maxAgeSeconds: env.SESSION_TTL_HOURS * 3600 });
  // Non-HttpOnly cookie so the frontend JS can read it and echo it back as the
  // X-CSRF-Token header (double-submit pattern). It carries no auth power on its own.
  setCookie(res, 'csrf', csrf, { maxAgeSeconds: env.SESSION_TTL_HOURS * 3600, httpOnly: false });
  return csrf;
}

async function login(req, res) {
  const ip = getClientIp(req);
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return sendJson(res, 400, { error: 'Correo y contrasena son obligatorios.' });

  if (isLoginBlocked(email, ip)) {
    return sendJson(res, 429, { error: `Demasiados intentos fallidos. Intenta de nuevo en ${WINDOW_MINUTES} minutos.` });
  }

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = row && row.password_hash && verifyPassword(password, row.password_hash);
  recordLoginAttempt(email, ip, !!ok);

  if (!ok) {
    logAction({ organizationId: row ? row.organization_id : null, userId: row ? row.id : null, action: 'auth.login_failed', ip, metadata: { email } });
    return sendJson(res, 401, { error: 'Credenciales invalidas.' });
  }
  if (row.status !== 'active') {
    return sendJson(res, 403, { error: 'Tu cuenta no esta activa. Contacta a tu administrador.' });
  }
  if (row.organization_id) {
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(row.organization_id);
    if (!org || org.status !== 'active') {
      return sendJson(res, 403, { error: 'La organizacion asociada a esta cuenta esta desactivada.' });
    }
  }

  const csrf = issueSession(res, row);
  logAction({ organizationId: row.organization_id, userId: row.id, action: 'auth.login', ip });
  const fullUser = buildUserContext(row);
  sendJson(res, 200, { user: publicUser(fullUser), csrfToken: csrf });
}

function buildUserContext(row) {
  const permissions = new Set();
  if (row.is_super_admin) {
    for (const p of db.prepare('SELECT code FROM permissions').all()) permissions.add(p.code);
  } else {
    const rows = db.prepare(`
      SELECT p.code FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ?
    `).all(row.id);
    for (const r of rows) permissions.add(r.code);
  }
  const roleNames = db.prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`).all(row.id).map(r => r.name);
  let organization = null;
  if (row.organization_id) organization = db.prepare('SELECT * FROM organizations WHERE id = ?').get(row.organization_id);
  return {
    id: row.id, email: row.email, organizationId: row.organization_id, organization,
    isSuperAdmin: !!row.is_super_admin, permissions, roles: roleNames,
  };
}

function logout(req, res) {
  const user = loadUserFromRequest(req);
  clearCookie(res, 'session');
  clearCookie(res, 'csrf');
  if (user) logAction({ organizationId: user.organizationId, userId: user.id, action: 'auth.logout', ip: getClientIp(req) });
  sendJson(res, 200, { ok: true });
}

function me(req, res) {
  const user = loadUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: 'No autenticado' });
  sendJson(res, 200, { user: publicUser(user) });
}

async function forgotPassword(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const email = String(body.email || '').trim().toLowerCase();
  // Always respond 200 (don't leak which emails exist).
  const user = db.prepare(`SELECT * FROM users WHERE email = ? AND status = 'active'`).get(email);
  if (user) {
    const token = randomToken(32);
    db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`)
      .run(uid('pwr'), user.id, sha256Hex(token));
    sendMail({ to: user.email, subject: 'Restablece tu contrasena', kind: 'password_reset', link: `/reset-password.html?token=${token}` });
    logAction({ organizationId: user.organization_id, userId: user.id, action: 'auth.password_reset_requested', ip: getClientIp(req) });
  }
  sendJson(res, 200, { ok: true, message: 'Si el correo existe, se enviaron instrucciones de recuperacion.' });
}

async function resetPassword(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const token = String(body.token || '');
  const newPassword = String(body.newPassword || '');
  if (!token || newPassword.length < 8) return sendJson(res, 400, { error: 'Token invalido o contrasena muy corta (minimo 8 caracteres).' });

  const tokenHash = sha256Hex(token);
  const row = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`).get(tokenHash);
  if (!row) return sendJson(res, 400, { error: 'El enlace de recuperacion es invalido o ha expirado.' });

  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(hashPassword(newPassword), row.user_id);
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  logAction({ organizationId: user.organization_id, userId: user.id, action: 'auth.password_reset_completed', ip: getClientIp(req) });
  sendJson(res, 200, { ok: true });
}

async function acceptInvite(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token || password.length < 8) return sendJson(res, 400, { error: 'Token invalido o contrasena muy corta (minimo 8 caracteres).' });

  const tokenHash = sha256Hex(token);
  const invite = db.prepare(`SELECT * FROM invitations WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`).get(tokenHash);
  if (!invite) return sendJson(res, 400, { error: 'La invitacion es invalida, ya fue usada o expiro.' });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(invite.organization_id);
  if (!org || org.status !== 'active') return sendJson(res, 403, { error: 'La organizacion de esta invitacion no esta activa.' });

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(invite.email);
  if (user) {
    db.prepare(`UPDATE users SET password_hash = ?, status = 'active', organization_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(hashPassword(password), invite.organization_id, user.id);
  } else {
    const userId = uid('user');
    db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, status) VALUES (?, ?, ?, ?, 'active')`)
      .run(userId, invite.organization_id, invite.email, hashPassword(password));
    user = { id: userId };
  }
  db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, organization_id) VALUES (?, ?, ?)').run(user.id, invite.role_id, invite.organization_id);
  db.prepare(`UPDATE invitations SET used_at = datetime('now') WHERE id = ?`).run(invite.id);
  logAction({ organizationId: invite.organization_id, userId: user.id, action: 'auth.invite_accepted', ip: getClientIp(req), resourceType: 'user', resourceId: user.id });
  sendJson(res, 200, { ok: true, message: 'Cuenta activada. Ya puedes iniciar sesion.' });
}

module.exports = { login, logout, me, forgotPassword, resetPassword, acceptInvite, buildUserContext, publicUser };
