'use strict';
const { db, uid, createDefaultRolesForOrg, getOrgRoleByName } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { randomToken, sha256Hex, hashPassword } = require('../lib/crypto');
const { sendMail } = require('../lib/mailer');
const { describeAudit } = require('../lib/audit-describe');
const { todayISOInBogota, addDaysISO } = require('../lib/bogota-time');

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
  const nit = String(body.nit || '').trim();
  const phone = String(body.phone || '').trim();
  const contactEmail = String(body.contactEmail || '').trim();
  if (!name) return sendJson(res, 400, { error: 'El nombre de la organizacion es obligatorio.' });
  if (!nit) return sendJson(res, 400, { error: 'El NIT es obligatorio.' });
  if (!phone) return sendJson(res, 400, { error: 'El numero de telefono es obligatorio.' });
  if (!contactEmail) return sendJson(res, 400, { error: 'El correo electronico es obligatorio.' });
  const slug = body.slug ? slugify(body.slug) : slugify(name);
  if (db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
    return sendJson(res, 409, { error: 'Ya existe una organizacion con ese identificador (slug).' });
  }
  const id = uid('org');
  db.prepare(`INSERT INTO organizations (id, name, slug, status, settings_json, nit, phone, contact_email) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(id, name, slug, JSON.stringify(body.settings || {}), nit, phone, contactEmail);
  db.prepare('INSERT INTO org_settings (organization_id, org_name) VALUES (?, ?)').run(id, name);
  createDefaultRolesForOrg(id);
  logAction({ organizationId: id, userId: req.user.id, action: 'organization.create', resourceType: 'organization', resourceId: id, ip: getClientIp(req), metadata: { name, nit } });
  sendJson(res, 201, { organization: { id, name, slug, status: 'active', nit, phone, contactEmail } });
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

// Eliminar es irreversible: solo se permite con la organizacion ya
// DESACTIVADA y escribiendo su nombre exacto como confirmacion.
async function deleteOrganization(req, res, params) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.id);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  let body = {};
  try { body = await readBody(req); } catch { body = {}; }
  if (org.status === 'active') return sendJson(res, 409, { error: 'Primero desactiva la organizacion. Solo se puede eliminar una organizacion inactiva.' });
  if (String(body.confirmName || '').trim() !== String(org.name).trim()) return sendJson(res, 400, { error: 'El nombre escrito no coincide con el de la organizacion. No se elimino nada.' });
  db.prepare('DELETE FROM organizations WHERE id = ?').run(org.id); // ON DELETE CASCADE cleans up dependent rows
  logAction({ organizationId: null, userId: req.user.id, action: 'organization.delete', resourceType: 'organization', resourceId: org.id, ip: getClientIp(req), metadata: { name: org.name } });
  sendJson(res, 200, { ok: true });
}

function getOrganizationDetail(req, res, params) {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(params.id);
  if (!org) return sendJson(res, 404, { error: 'Organizacion no encontrada.' });
  const users = db.prepare('SELECT id, email, status, created_at FROM users WHERE organization_id = ?').all(org.id);
  const roles = db.prepare('SELECT id, name FROM roles WHERE organization_id = ?').all(org.id);
  // Cuanta informacion tiene (se muestra antes de eliminarla).
  const count = (sql) => { try { return db.prepare(sql).get(org.id).c; } catch { return 0; } };
  const stats = {
    employees: count('SELECT COUNT(*) c FROM employees WHERE organization_id = ?'),
    marks: count('SELECT COUNT(*) c FROM attendance_marks WHERE organization_id = ?'),
    devices: count('SELECT COUNT(*) c FROM attendance_devices WHERE organization_id = ?'),
  };
  sendJson(res, 200, { organization: { ...org, settings: JSON.parse(org.settings_json || '{}') }, users, roles, stats });
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
  const mail = await sendMail({ to: email, subject: `Invitacion a ${org.name}`, kind: 'invitation', link: `/accept-invite.html?token=${token}` });
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

function deleteUser(req, res, params) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!user || user.is_super_admin) return sendJson(res, 404, { error: 'Usuario no encontrado.' });
  db.prepare('UPDATE invitations SET created_by = NULL WHERE created_by = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  logAction({ organizationId: user.organization_id, userId: req.user.id, action: 'user.delete', resourceType: 'user', resourceId: user.id, ip: getClientIp(req), metadata: { email: user.email } });
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

async function resetUserPassword(req, res, params) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!user) return sendJson(res, 404, { error: 'Usuario no encontrado.' });
  const token = randomToken(32);
  db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(uid('pwr'), user.id, sha256Hex(token));
  const mail = await sendMail({ to: user.email, subject: 'Restablecimiento de contrasena (solicitado por un administrador)', kind: 'password_reset', link: `/reset-password.html?token=${token}` });
  logAction({ organizationId: user.organization_id, userId: req.user.id, action: 'user.reset_password_requested', resourceType: 'user', resourceId: user.id, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, resetLink: mail.link, note: 'El enlace tambien se imprimio en la consola del servidor.' });
}

function listRolesForOrg(req, res, query) {
  if (!query.organization_id) return sendJson(res, 400, { error: 'organization_id es requerido.' });
  const roles = db.prepare('SELECT id, name FROM roles WHERE organization_id = ?').all(query.organization_id);
  sendJson(res, 200, { roles });
}

// GET /api/superadmin/audit?from=&to=&organization_id=&userId=&category=&q=
// Privacidad (Ley 1581): la plataforma es ENCARGADA de los datos de cada
// organizacion, asi que el Super Admin solo ve en detalle:
//   - las acciones de la plataforma y de cuentas Super Admin, y
//   - los eventos de seguridad (inicios de sesion, intentos fallidos,
//     contrasenas, invitaciones aceptadas).
// De la actividad interna de cada organizacion solo recibe un RESUMEN de uso
// (cantidad de acciones por tipo, usuarios activos y ultimo uso), sin datos
// personales. El detalle completo lo ve el administrador de cada organizacion.
const SECURITY_ACTIONS = new Set(['auth.login', 'auth.logout', 'auth.login_failed', 'auth.password_reset_requested', 'auth.password_reset_completed', 'auth.invite_accepted']);
function listAuditLogs(req, res, query) {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const from = ISO.test(query.from || '') ? query.from : addDaysISO(todayISOInBogota(), -30);
  const to = ISO.test(query.to || '') ? query.to : todayISOInBogota();
  let sql = 'SELECT * FROM audit_logs WHERE substr(created_at, 1, 10) BETWEEN ? AND ?';
  const params = [from, to];
  if (query.organization_id === 'plataforma') sql += ' AND organization_id IS NULL';
  else if (query.organization_id) { sql += ' AND organization_id = ?'; params.push(query.organization_id); }
  sql += ' ORDER BY created_at DESC LIMIT 20000';
  const rows = db.prepare(sql).all(...params);

  const ROLE_ES = { org_admin: 'Administrador', supervisor: 'Supervisor', empleado: 'Empleado', super_admin: 'Super Admin' };
  const users = new Map(db.prepare(`SELECT u.id, u.email, u.organization_id, u.is_super_admin,
      (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id LIMIT 1) AS role
    FROM users u`).all().map(u => [u.id, u]));
  const orgs = new Map(db.prepare('SELECT id, name FROM organizations').all().map(o => [o.id, o.name]));

  const logs = [];
  const usage = new Map(); // resumen por organizacion (sin datos personales)
  for (const r of rows) {
    const u = r.user_id ? users.get(r.user_id) : null;
    const isPlatform = !r.organization_id || (u && u.is_super_admin);
    const isSecurity = SECURITY_ACTIONS.has(r.action);
    const metadata = r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return null; } })() : null;
    if (isPlatform || isSecurity) {
      if (query.userId && r.user_id !== query.userId) continue;
      const d = describeAudit({ ...r, metadata }, { users, employees: new Map(), orgs });
      const role = u ? (u.is_super_admin ? 'Super Admin' : (ROLE_ES[u.role] || u.role || '')) : '';
      logs.push({
        id: r.id, at: r.created_at, created_at: r.created_at, action: r.action,
        organization_id: r.organization_id, orgName: r.organization_id ? (orgs.get(r.organization_id) || (metadata && metadata.name) || 'Organización eliminada') : 'Plataforma',
        user_id: r.user_id, user: u ? u.email : (d.actorFallback || 'Sistema'), role,
        category: d.category, title: d.title, text: d.text, details: d.details || [], ip: r.ip,
      });
    } else {
      // Actividad interna: solo se cuenta.
      const cat = describeAudit({ ...r, metadata }, {}).category;
      let o = usage.get(r.organization_id);
      if (!o) { o = { organizationId: r.organization_id, orgName: orgs.get(r.organization_id) || 'Organización eliminada', total: 0, byCategory: {}, users: new Set(), lastAt: null }; usage.set(r.organization_id, o); }
      o.total++;
      o.byCategory[cat] = (o.byCategory[cat] || 0) + 1;
      if (r.user_id) o.users.add(r.user_id);
      if (!o.lastAt || r.created_at > o.lastAt) o.lastAt = r.created_at;
    }
  }
  let detailed = logs;
  if (query.category) detailed = detailed.filter(l => l.category === query.category);
  if (query.q) { const q = String(query.q).toLowerCase(); detailed = detailed.filter(l => (l.text + ' ' + l.details.join(' ') + ' ' + l.user + ' ' + l.orgName).toLowerCase().includes(q)); }
  const usageList = [...usage.values()].map(o => ({ organizationId: o.organizationId, orgName: o.orgName, total: o.total, byCategory: o.byCategory, activeUsers: o.users.size, lastAt: o.lastAt }))
    .sort((a, b) => b.total - a.total);
  sendJson(res, 200, {
    from, to, logs: detailed.slice(0, 1500), truncated: detailed.length > 1500, usage: usageList,
    users: [...users.values()].map(u => ({ id: u.id, email: u.email, organizationId: u.organization_id, role: u.is_super_admin ? 'Super Admin' : (ROLE_ES[u.role] || u.role || '') })),
  });
}

module.exports = {
  dashboard, listOrganizations, createOrganization, updateOrganization, toggleOrganizationStatus,
  deleteOrganization, getOrganizationDetail, listUsers, createUser, updateUser, toggleUserStatus,
  deleteUser, resetUserPassword, listRolesForOrg, listAuditLogs,
};
