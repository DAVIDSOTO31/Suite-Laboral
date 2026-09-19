'use strict';
const { db, uid, createDefaultRolesForOrg, getOrgRoleByName } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { randomToken, sha256Hex, hashPassword } = require('../lib/crypto');
const { sendMail } = require('../lib/mailer');

function slugify(name) {
  return name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || uid('org').slice(0, 8);
}

function dashboard(req, res) {
  const orgs = db.prepare('SELECT status, COUNT(*) c FROM organizations GROUP BY status').all();
  const users = db.prepare('SELECT status, COUNT(*) c FROM users WHERE is_super_admin = 0 GROUP BY status').all();
  const toMap = (rows) => rows.reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
  const orgMap = toMap(orgs);
  const userMap = toMap(users);
  sendJson(res, 200, {
    organizations: { active: orgMap.active || 0, inactive: orgMap.inactive || 0, total: (orgMap.active || 0) + (orgMap.inactive || 0) },
    users: { active: userMap.active || 0, invited: userMap.invited || 0, inactive: userMap.inactive || 0, total: Object.values(userMap).reduce((a, b) => a + b, 0) },
  });
}

function listOrganizations(req, res, query) {
  let sql = 'SELECT * FROM organizations WHERE 1=1';
  const params = [];
  if (query.search) { sql += ' AND (name LIKE ? OR slug LIKE ?)'; params.push(`%${query.search}%`, `%${query.search}%`); }
  if (query.status) { sql += ' AND status = ?'; params.push(query.status); }
  sql += ' ORDER BY created_at DESC';
  const orgs = db.prepare(sql).all(...params);
  const withCounts = orgs.map(o => {
    const uc = db.prepare('SELECT COUNT(*) c FROM users WHERE organization_id = ?').get(o.id).c;
    return { ...o, settings: JSON.parse(o.settings_json || '{}'), userCount: uc };
  });
  sendJson(res, 200, { organizations: withCounts });
}

async function createOrganization(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const name = String(body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'El nombre de la organizacion es obligatorio.' });
  const slug = body.slug ? slugify(body.slug) : slugify(name);
  if (db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
    return sendJson(res, 409, { error: 'Ya existe una organizacion con ese identificador (slug).' });
  }
  const id = uid('org');
  db.prepare(`INSERT INTO organizations (id, name, slug, status, settings_json) VALUES (?, ?, ?, 'active', ?)`)
    .run(id, name, slug, JSON.stringify(body.settings || {}));
  db.prepare('INSERT INTO org_settings (organization_id, org_name) VALUES (?, ?)').run(id, name);
  createDefaultRolesForOrg(id);
  logAction({ organizationId: id, userId: req.user.id, action: 'organization.create', resourceType: 'organization', resourceId: id, ip: getClientIp(req), metadata: { name } });
  sendJson(res, 201, { organization: { id, name, slug, status: 'active' } });
}

async function updateOrganization(req, res, params) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.id);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const name = body.name != null ? String(body.name).trim() : org.name;
  const settings = body.settings != null ? JSON.stringify(body.settings) : org.settings_json;
  db.prepare(`UPDATE organizations SET name = ?, settings_json = ?, updated_at = datetime('now') WHERE id = ?`).run(name, settings, org.id);
  logAction({ organizationId: org.id, userId: req.user.id, action: 'organization.update', resourceType: 'organization', resourceId: org.id, ip: getClientIp(req), metadata: { name } });
  sendJson(res, 200, { ok: true });
}

async function toggleOrganizationStatus(req, res, params) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.id);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  const newStatus = org.status === 'active' ? 'inactive' : 'active';
  db.prepare(`UPDATE organizations SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, org.id);
  logAction({ organizationId: org.id, userId: req.user.id, action: newStatus === 'active' ? 'organization.activate' : 'organization.deactivate', resourceType: 'organization', resourceId: org.id, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, status: newStatus });
}

function deleteOrganization(req, res, params) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.id);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  db.prepare('DELETE FROM organizations WHERE id = ?').run(org.id); // ON DELETE CASCADE cleans up dependent rows
  logAction({ organizationId: null, userId: req.user.id, action: 'organization.delete', resourceType: 'organization', resourceId: org.id, ip: getClientIp(req), metadata: { name: org.name } });
  sendJson(res, 200, { ok: true });
}

function getOrganizationDetail(req, res, params) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.id);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  const users = db.prepare('SELECT id, email, status, created_at FROM users WHERE organization_id = ?').all(org.id);
  const roles = db.prepare('SELECT id, name FROM roles WHERE organization_id = ?').all(org.id);
  sendJson(res, 200, { organization: { ...org, settings: JSON.parse(org.settings_json || '{}') }, users, roles });
}

// ---------------------------------------------------------------------------
// Global users (across all organizations)
// ---------------------------------------------------------------------------
function listUsers(req, res, query) {
  let sql = `SELECT u.*, o.name as organization_name FROM users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.is_super_admin = 0`;
  const params = [];
  if (query.organization_id) { sql += ' AND u.organization_id = ?'; params.push(query.organization_id); }
  if (query.search) { sql += ' AND u.email LIKE ?'; params.push(`%${query.search}%`); }
  sql += ' ORDER BY u.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  const users = rows.map(u => {
    const roles = db.prepare('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').all(u.id).map(r => r.name);
    return { id: u.id, email: u.email, status: u.status, organizationId: u.organization_id, organizationName: u.organization_name, roles, createdAt: u.created_at };
  });
  sendJson(res, 200, { users });
}

async function createUser(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const organizationId = String(body.organizationId || '');
  const roleName = String(body.role || 'empleado');
  if (!email || !organizationId) return sendJson(res, 400, { error: 'Correo y organizacion son obligatorios.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return sendJson(res, 409, { error: 'Ya existe un usuario con ese correo.' });
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  const role = getOrgRoleByName(organizationId, roleName) || getOrgRoleByName(organizationId, 'empleado');

  // Invitation flow: no password is set/known by the admin. The user sets their own via a secure link.
  const userId = uid('user');
  db.prepare(`INSERT INTO users (id, organization_id, email, status) VALUES (?, ?, ?, 'invited')`).run(userId, organizationId, email);
  const token = randomToken(32);
  db.prepare(`INSERT INTO invitations (id, organization_id, email, role_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?, datetime('now', '+3 days'), ?)`)
    .run(uid('inv'), organizationId, email, role.id, sha256Hex(token), req.user.id);
  const mail = sendMail({ to: email, subject: `Invitacion a ${org.name}`, kind: 'invitation', link: `/accept-invite.html?token=${token}` });
  logAction({ organizationId, userId: req.user.id, action: 'user.invite', resourceType: 'user', resourceId: userId, ip: getClientIp(req), metadata: { email, role: roleName } });
  sendJson(res, 201, { ok: true, userId, inviteLink: mail.link, note: 'El enlace de invitacion tambien se imprimio en la consola del servidor.' });
}

async function updateUser(req, res, params) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!user || user.is_super_admin) return sendJson(res, 404, { error: 'Usuario no encontrado.' });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const updates = {};
  if (body.organizationId) updates.organization_id = body.organizationId;
  if (body.status) updates.status = body.status;
  const fields = Object.keys(updates);
  if (fields.length) {
    const setSql = fields.map(f => `${f} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${setSql}, updated_at = datetime('now') WHERE id = ?`).run(...fields.map(f => updates[f]), user.id);
  }
  if (body.role) {
    const org = updates.organization_id || user.organization_id;
    const role = getOrgRoleByName(org, body.role);
    if (role) {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (?, ?, ?)').run(user.id, role.id, org);
    }
  }
  logAction({ organizationId: updates.organization_id || user.organization_id, userId: req.user.id, action: 'user.update', resourceType: 'user', resourceId: user.id, ip: getClientIp(req), metadata: body });
  sendJson(res, 200, { ok: true });
}

function toggleUserStatus(req, res, params) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!user || user.is_super_admin) return sendJson(res, 404, { error: 'Usuario no encontrado.' });
  const newStatus = user.status === 'active' ? 'inactive' : 'active';
  db.prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, user.id);
  logAction({ organizationId: user.organization_id, userId: req.user.id, action: newStatus === 'active' ? 'user.activate' : 'user.deactivate', resourceType: 'user', resourceId: user.id, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, status: newStatus });
}

function resetUserPassword(req, res, params) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!user) return sendJson(res, 404, { error: 'Usuario no encontrado.' });
  const token = randomToken(32);
  db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(uid('pwr'), user.id, sha256Hex(token));
  const mail = sendMail({ to: user.email, subject: 'Restablecimiento de contrasena (solicitado por un administrador)', kind: 'password_reset', link: `/reset-password.html?token=${token}` });
  logAction({ organizationId: user.organization_id, userId: req.user.id, action: 'user.reset_password_requested', resourceType: 'user', resourceId: user.id, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, resetLink: mail.link, note: 'El enlace tambien se imprimio en la consola del servidor.' });
}

function listRolesForOrg(req, res, query) {
  if (!query.organization_id) return sendJson(res, 400, { error: 'organization_id es requerido.' });
  const roles = db.prepare('SELECT id, name FROM roles WHERE organization_id = ?').all(query.organization_id);
  sendJson(res, 200, { roles });
}

function listAuditLogs(req, res, query) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (query.organization_id) { sql += ' AND organization_id = ?'; params.push(query.organization_id); }
  if (query.action) { sql += ' AND action LIKE ?'; params.push(`%${query.action}%`); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  sendJson(res, 200, { logs: rows.map(r => ({ ...r, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null })) });
}

module.exports = {
  dashboard, listOrganizations, createOrganization, updateOrganization, toggleOrganizationStatus,
  deleteOrganization, getOrganizationDetail, listUsers, createUser, updateUser, toggleUserStatus,
  resetUserPassword, listRolesForOrg, listAuditLogs,
};
