'use strict';
const { db, uid, seedDemoDataForOrg, getOrgRoleByName } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { randomToken, sha256Hex } = require('../lib/crypto');
const { sendMail } = require('../lib/mailer');

// Resolves which organization a request should act on. Normal users are always
// pinned to their own organization_id. A super admin MAY act on behalf of a
// specific organization by passing organization_id explicitly (never implicitly).
function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}

function getOrgData(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });

  const settingsRow = db.prepare('SELECT * FROM org_settings WHERE organization_id = ?').get(orgId);
  const departments = db.prepare('SELECT id, name, icon FROM departments WHERE organization_id = ? ORDER BY position ASC').all(orgId);
  const presetRows = db.prepare('SELECT data_json FROM shift_presets WHERE organization_id = ?').all(orgId);
  const employees = db.prepare('SELECT id, name, role, department, department_id as departmentId, salary FROM employees WHERE organization_id = ?').all(orgId);
  const shiftRows = db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId);

  sendJson(res, 200, {
    organizationId: orgId,
    orgSettings: settingsRow ? { orgName: settingsRow.org_name, logo: settingsRow.logo_base64, minimumWage: settingsRow.minimum_wage } : { orgName: 'Empresa', logo: null, minimumWage: 1750905 },
    departments,
    shiftPresets: presetRows.map(r => JSON.parse(r.data_json)),
    employees,
    shifts: shiftRows.map(r => JSON.parse(r.data_json)),
    isEmpty: employees.length === 0 && departments.length === 0,
  });
}

function seedDemo(req, res, body) {
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const existing = db.prepare('SELECT COUNT(*) c FROM employees WHERE organization_id = ?').get(orgId).c;
  if (existing > 0) return sendJson(res, 409, { error: 'Esta organizacion ya tiene datos; no se cargaron datos de demostracion.' });
  seedDemoDataForOrg(orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'org_data.seed_demo', ip: getClientIp(req) });
  sendJson(res, 200, { ok: true });
}

async function updateSettings(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const current = db.prepare('SELECT * FROM org_settings WHERE organization_id = ?').get(orgId);
  const orgName = body.orgName != null ? String(body.orgName).slice(0, 120) : (current ? current.org_name : 'Empresa');
  const logo = body.logo !== undefined ? body.logo : (current ? current.logo_base64 : null);
  const minimumWage = body.minimumWage != null ? Number(body.minimumWage) : (current ? current.minimum_wage : 1750905);
  db.prepare(`
    INSERT INTO org_settings (organization_id, org_name, logo_base64, minimum_wage, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(organization_id) DO UPDATE SET org_name = excluded.org_name, logo_base64 = excluded.logo_base64, minimum_wage = excluded.minimum_wage, updated_at = datetime('now')
  `).run(orgId, orgName, logo, minimumWage);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'settings.update', ip: getClientIp(req), metadata: { orgName } });
  sendJson(res, 200, { ok: true });
}

async function replaceDepartments(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const list = Array.isArray(body.departments) ? body.departments : [];
  db.prepare('DELETE FROM departments WHERE organization_id = ?').run(orgId);
  const insert = db.prepare('INSERT INTO departments (id, organization_id, name, icon, position) VALUES (?, ?, ?, ?, ?)');
  list.forEach((d, idx) => {
    insert.run(String(d.id || uid('dept')), orgId, String(d.name || '').slice(0, 80), String(d.icon || 'fa-briefcase'), idx);
  });
  logAction({ organizationId: orgId, userId: req.user.id, action: 'departments.replace', ip: getClientIp(req), metadata: { count: list.length } });
  sendJson(res, 200, { ok: true });
}

async function replaceShiftPresets(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const list = Array.isArray(body.shiftPresets) ? body.shiftPresets : [];
  db.prepare('DELETE FROM shift_presets WHERE organization_id = ?').run(orgId);
  const insert = db.prepare('INSERT INTO shift_presets (id, organization_id, data_json) VALUES (?, ?, ?)');
  list.forEach((p) => insert.run(String(p.id || uid('preset')), orgId, JSON.stringify(p)));
  logAction({ organizationId: orgId, userId: req.user.id, action: 'shift_presets.replace', ip: getClientIp(req), metadata: { count: list.length } });
  sendJson(res, 200, { ok: true });
}

// Full-state sync for employees + shifts. Pragmatic choice for this stage of the
// migration: the original app kept these purely in memory (no persistence at all),
// so a debounced "replace everything for this org" sync is a safe, simple, fully
// isolated first step. See README for the roadmap to fully granular per-record
// endpoints (POST/PUT/DELETE per employee/shift) if finer-grained audit trails
// or concurrent multi-editor support are needed later.
async function syncEmployeesAndShifts(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });

  if (Array.isArray(body.employees)) {
    db.prepare('DELETE FROM employees WHERE organization_id = ?').run(orgId);
    const insert = db.prepare('INSERT INTO employees (id, organization_id, name, role, department, department_id, salary) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const e of body.employees) {
      insert.run(e.id, orgId, String(e.name || '').slice(0, 120), String(e.role || '').slice(0, 120), e.department || null, e.departmentId || null, Number(e.salary) || 0);
    }
  }
  if (Array.isArray(body.shifts)) {
    db.prepare('DELETE FROM shifts WHERE organization_id = ?').run(orgId);
    const insert = db.prepare('INSERT INTO shifts (id, organization_id, data_json) VALUES (?, ?, ?)');
    for (const s of body.shifts) {
      const id = s.id || `${s.empId}_${s.date}_${uid('s')}`;
      insert.run(id, orgId, JSON.stringify(s));
    }
  }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'org_data.sync', ip: getClientIp(req), metadata: { employees: (body.employees || []).length, shifts: (body.shifts || []).length } });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Org-scoped user management (organization admins manage only their own org)
// ---------------------------------------------------------------------------
function listOrgUsers(req, res) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'Solo disponible para cuentas de organizacion.' });
  const rows = db.prepare('SELECT id, email, status, created_at FROM users WHERE organization_id = ?').all(orgId);
  const users = rows.map(u => ({
    ...u,
    roles: db.prepare('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').all(u.id).map(r => r.name),
  }));
  sendJson(res, 200, { users });
}

async function createOrgUser(req, res) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'Solo disponible para cuentas de organizacion.' });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const roleName = String(body.role || 'empleado');
  if (!email) return sendJson(res, 400, { error: 'El correo es obligatorio.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return sendJson(res, 409, { error: 'Ya existe un usuario con ese correo.' });
  const role = getOrgRoleByName(orgId, roleName) || getOrgRoleByName(orgId, 'empleado');

  const userId = uid('user');
  db.prepare(`INSERT INTO users (id, organization_id, email, status) VALUES (?, ?, ?, 'invited')`).run(userId, orgId, email);
  const token = randomToken(32);
  db.prepare(`INSERT INTO invitations (id, organization_id, email, role_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?, datetime('now', '+3 days'), ?)`)
    .run(uid('inv'), orgId, email, role.id, sha256Hex(token), req.user.id);
  const mail = await sendMail({ to: email, subject: `Invitacion a tu organizacion`, kind: 'invitation', link: `/accept-invite.html?token=${token}` });
  logAction({ organizationId: orgId, userId: req.user.id, action: 'user.invite', resourceType: 'user', resourceId: userId, ip: getClientIp(req), metadata: { email, role: roleName } });
  sendJson(res, 201, { ok: true, inviteLink: mail.link, note: 'El enlace de invitacion tambien se imprimio en la consola del servidor.' });
}

function assertOrgUserOwnership(req, res, targetUserId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
  if (!target || target.organization_id !== req.user.organizationId) {
    sendJson(res, 404, { error: 'Usuario no encontrado.' }); // never reveal cross-tenant existence
    return null;
  }
  return target;
}

async function updateOrgUser(req, res, params) {
  const target = assertOrgUserOwnership(req, res, params.id);
  if (!target) return;
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  if (body.role) {
    const role = getOrgRoleByName(req.user.organizationId, body.role);
    if (role) {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(target.id);
      db.prepare('INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (?, ?, ?)').run(target.id, role.id, req.user.organizationId);
    }
  }
  logAction({ organizationId: req.user.organizationId, userId: req.user.id, action: 'user.update', resourceType: 'user', resourceId: target.id, ip: getClientIp(req), metadata: body });
  sendJson(res, 200, { ok: true });
}

function toggleOrgUserStatus(req, res, params) {
  const target = assertOrgUserOwnership(req, res, params.id);
  if (!target) return;
  const newStatus = target.status === 'active' ? 'inactive' : 'active';
  db.prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, target.id);
  logAction({ organizationId: req.user.organizationId, userId: req.user.id, action: newStatus === 'active' ? 'user.activate' : 'user.deactivate', resourceType: 'user', resourceId: target.id, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, status: newStatus });
}

async function resetOrgUserPassword(req, res, params) {
  const target = assertOrgUserOwnership(req, res, params.id);
  if (!target) return;
  const token = randomToken(32);
  db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(uid('pwr'), target.id, sha256Hex(token));
  const mail = await sendMail({ to: target.email, subject: 'Restablecimiento de contrasena', kind: 'password_reset', link: `/reset-password.html?token=${token}` });
  logAction({ organizationId: req.user.organizationId, userId: req.user.id, action: 'user.reset_password_requested', resourceType: 'user', resourceId: target.id, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, resetLink: mail.link });
}

function listOrgAudit(req, res) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'Solo disponible para cuentas de organizacion.' });
  const rows = db.prepare('SELECT * FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200').all(orgId);
  sendJson(res, 200, { logs: rows.map(r => ({ ...r, metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null })) });
}

module.exports = {
  getOrgData, seedDemo, updateSettings, replaceDepartments, replaceShiftPresets, syncEmployeesAndShifts,
  listOrgUsers, createOrgUser, updateOrgUser, toggleOrgUserStatus, resetOrgUserPassword, listOrgAudit,
  resolveOrgId,
};
