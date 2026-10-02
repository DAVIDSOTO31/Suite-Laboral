'use strict';
const { db } = require('../db');
const { verifySession } = require('../lib/crypto');
const { parseCookies, sendJson } = require('../lib/http');

// Loads the authenticated user fresh from the DB on every request (never trusts
// stale data inside the signed cookie beyond the user id) so that a deactivated
// user or a deactivated/deleted organization is locked out immediately.
function loadUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  const payload = verifySession(token);
  if (!payload || !payload.uid) return null;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return null;
  if (user.status !== 'active') return null;

  let organization = null;
  if (user.organization_id) {
    organization = db.prepare('SELECT * FROM organizations WHERE id = ?').get(user.organization_id);
    if (!organization || organization.status !== 'active') return null; // org deactivated -> locked out
  }

  const permissions = new Set();
  if (user.is_super_admin) {
    for (const p of db.prepare('SELECT code FROM permissions').all()) permissions.add(p.code);
  } else {
    const rows = db.prepare(`
      SELECT p.code FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ?
    `).all(user.id);
    for (const r of rows) permissions.add(r.code);
  }

  const roleNames = db.prepare(`
    SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?
  `).all(user.id).map(r => r.name);

  return {
    id: user.id,
    email: user.email,
    organizationId: user.organization_id,
    organization,
    isSuperAdmin: !!user.is_super_admin,
    permissions,
    roles: roleNames,
    csrfToken: payload.csrf,
  };
}

function requireAuth(req, res) {
  const user = loadUserFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: 'No autenticado. Inicia sesion nuevamente.' });
    return null;
  }
  req.user = user;
  return user;
}

// Double-submit CSRF check for state-changing requests (POST/PUT/DELETE).
// The token issued at login is stored in the signed cookie AND must be echoed
// back by the client in the X-CSRF-Token header (read from a non-HttpOnly cookie).
function requireCsrf(req, res, user) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return true;
  const header = req.headers['x-csrf-token'];
  if (!header || header !== user.csrfToken) {
    sendJson(res, 403, { error: 'Token CSRF invalido o ausente.' });
    return false;
  }
  return true;
}

function requirePermission(code) {
  return (req, res, user) => {
    if (user.isSuperAdmin || user.permissions.has(code)) return true;
    sendJson(res, 403, { error: `No tienes el permiso requerido: ${code}` });
    return false;
  };
}

function requireSuperAdmin(req, res, user) {
  if (user.isSuperAdmin) return true;
  sendJson(res, 403, { error: 'Esta accion requiere privilegios de Super Admin.' });
  return false;
}

// Ensures a resource's organization_id (already loaded from DB) matches the
// caller's own organization -- the core anti-IDOR / cross-tenant guard.
// Super admins may bypass, but ONLY explicitly (never silently).
function assertSameOrg(res, user, resourceOrgId, { allowSuperAdmin = true } = {}) {
  if (user.isSuperAdmin && allowSuperAdmin) return true;
  if (user.organizationId && user.organizationId === resourceOrgId) return true;
  sendJson(res, 404, { error: 'Recurso no encontrado.' }); // 404, not 403: don't confirm existence to other tenants
  return false;
}

module.exports = { loadUserFromRequest, requireAuth, requireCsrf, requirePermission, requireSuperAdmin, assertSameOrg };
