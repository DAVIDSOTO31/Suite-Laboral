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

// Correo normalizado (minusculas, sin espacios). Devuelve null si esta vacio
// y false si el formato no es valido.
function normalizeEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!e) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 160 ? e : false;
}

// Vincula automaticamente usuarios y colaboradores con el MISMO correo, solo
// cuando ninguno de los dos esta vinculado todavia. Devuelve lo vinculado.
function autoLinkByEmail(orgId) {
  const pairs = db.prepare(`
    SELECT u.id AS userId, u.email AS email, e.id AS employeeId, e.name AS employeeName
    FROM users u
    JOIN employees e ON e.organization_id = u.organization_id AND e.email IS NOT NULL AND lower(e.email) = lower(u.email)
    WHERE u.organization_id = ? AND u.employee_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.organization_id = u.organization_id AND u2.employee_id = e.id)
  `).all(orgId);
  const link = db.prepare(`UPDATE users SET employee_id = ?, updated_at = datetime('now') WHERE id = ? AND employee_id IS NULL`);
  const done = [];
  const usedEmployees = new Set();
  for (const p of pairs) {
    if (usedEmployees.has(p.employeeId)) continue;
    if (link.run(p.employeeId, p.userId).changes) { usedEmployees.add(p.employeeId); done.push({ email: p.email, employeeName: p.employeeName }); }
  }
  return done;
}

// ¿El usuario tiene este permiso? (el Super Admin los tiene todos)
function can(req, code) {
  return !!(req.user.isSuperAdmin || (req.user.permissions && req.user.permissions.has(code)));
}

function getOrgData(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });

  const settingsRow = db.prepare('SELECT * FROM org_settings WHERE organization_id = ?').get(orgId);
  const departments = db.prepare('SELECT id, name, icon FROM departments WHERE organization_id = ? ORDER BY position ASC').all(orgId);
  const presetRows = db.prepare('SELECT data_json FROM shift_presets WHERE organization_id = ?').all(orgId);
  let employees = db.prepare('SELECT id, name, role, department, department_id as departmentId, salary, night_surcharge, night_surcharge_reason, email, count_worked_days FROM employees WHERE organization_id = ?').all(orgId)
    .map(({ night_surcharge, night_surcharge_reason, email, count_worked_days, ...e }) => ({ ...e, email: email || '', nightSurcharge: night_surcharge !== 0, nightSurchargeReason: night_surcharge_reason || '', countWorkedDays: count_worked_days === 1 }));
  // Usuario de la suite vinculado a cada colaborador (solo para quien gestiona usuarios).
  if (can(req, 'users.view')) {
    const linkedUsers = new Map(db.prepare('SELECT employee_id, email, status FROM users WHERE organization_id = ? AND employee_id IS NOT NULL').all(orgId)
      .map(u => [Number(u.employee_id), { email: u.email, status: u.status }]));
    employees = employees.map(e => ({ ...e, linkedUser: linkedUsers.get(Number(e.id)) || null }));
  }
  let shifts = db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId).map(r => JSON.parse(r.data_json));

  // Alcance segun el rol:
  //  - Administrador / Supervisor: toda la organizacion.
  //  - Empleado: SOLO su propia ficha y sus propios turnos (si su usuario esta
  //    vinculado a una ficha de colaborador); nada de los demas.
  const scope = (can(req, 'employees.view') || can(req, 'shifts.view')) ? 'all' : 'self';
  const selfEmployeeId = req.user.employeeId != null ? Number(req.user.employeeId) : null;
  if (scope === 'self') {
    employees = selfEmployeeId != null ? employees.filter(e => Number(e.id) === selfEmployeeId) : [];
    shifts = selfEmployeeId != null ? shifts.filter(sh => Number(sh.empId) === selfEmployeeId) : [];
  }
  // Salarios y datos de nomina solo para quien puede ver reportes/nomina.
  const canSeePayroll = can(req, 'reports.view');
  if (!canSeePayroll) {
    employees = employees.map(({ salary, nightSurchargeReason, ...e }) => e);
  }

  sendJson(res, 200, {
    organizationId: orgId,
    orgSettings: settingsRow ? { orgName: settingsRow.org_name, logo: settingsRow.logo_base64, minimumWage: settingsRow.minimum_wage } : { orgName: 'Empresa', logo: null, minimumWage: 1750905 },
    departments,
    shiftPresets: presetRows.map(r => JSON.parse(r.data_json)),
    employees,
    shifts,
    viewer: { scope, employeeId: selfEmployeeId, canSeePayroll },
    isEmpty: scope === 'all' && employees.length === 0 && departments.length === 0,
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

  // Cada cambio se aplica SOLO si el usuario tiene el permiso correspondiente.
  // Lo que no tenga permiso se ignora (no se borra ni se modifica nada) y se
  // informa en la respuesta, en lugar de rechazar toda la sincronizacion.
  const ignored = [];
  const canCreate = can(req, 'employees.create');
  const canEdit = can(req, 'employees.edit');
  const canDelete = can(req, 'employees.delete');
  const canPayroll = can(req, 'employees.edit_payroll');
  const canShifts = can(req, 'shifts.edit');

  if (Array.isArray(body.employees)) {
    // Los empleados se ACTUALIZAN (no se borran y recrean) para no arrastrar en
    // cascada su historial de asistencia ni su perfil biometrico.
    const existing = new Map(
      db.prepare('SELECT id, name, salary, night_surcharge, night_surcharge_reason, email, count_worked_days FROM employees WHERE organization_id = ?').all(orgId).map(r => [Number(r.id), r])
    );
    const incomingIds = new Set(body.employees.map(e => Number(e.id)));
    const toDelete = [...existing.keys()].filter(id => !incomingIds.has(id));
    if (toDelete.length) {
      if (canDelete) {
        const del = db.prepare('DELETE FROM employees WHERE organization_id = ? AND id = ?');
        for (const id of toDelete) del.run(orgId, id);
      } else {
        ignored.push(`eliminar ${toDelete.length} colaborador(es): requiere permiso de eliminar colaboradores`);
      }
    }
    const settingsRow = db.prepare('SELECT minimum_wage FROM org_settings WHERE organization_id = ?').get(orgId);
    const defaultSalary = (settingsRow && settingsRow.minimum_wage) || 1750905;
    const upsert = db.prepare(`
      INSERT INTO employees (id, organization_id, name, role, department, department_id, salary, night_surcharge, night_surcharge_reason, email, count_worked_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, department = excluded.department, department_id = excluded.department_id, salary = excluded.salary,
        night_surcharge = excluded.night_surcharge, night_surcharge_reason = excluded.night_surcharge_reason, email = excluded.email, count_worked_days = excluded.count_worked_days
    `);
    let payrollIgnored = false;
    // Correos ya usados por colaboradores que NO vienen en la lista (y se conservan).
    const usedEmails = new Map();
    for (const [id, r] of existing) {
      if (!incomingIds.has(id) && !canDelete && r.email) usedEmails.set(String(r.email).toLowerCase(), id);
    }
    for (const e of body.employees) {
      const prev = existing.get(Number(e.id));
      if (!prev && !canCreate) { ignored.push(`crear "${String(e.name || '').slice(0, 60)}": requiere permiso de crear colaboradores`); continue; }
      if (prev && !canEdit) continue;

      // Correo opcional: valido y unico dentro de la organizacion.
      let email = normalizeEmail(e.email);
      if (email === false) { ignored.push(`correo no valido para "${String(e.name || '').slice(0, 60)}"`); email = prev ? (prev.email || null) : null; }
      if (email && usedEmails.has(email) && usedEmails.get(email) !== Number(e.id)) {
        ignored.push(`el correo ${email} ya pertenece a otro colaborador`);
        email = prev && prev.email && String(prev.email).toLowerCase() !== email ? prev.email : null;
      }
      if (email) usedEmails.set(String(email).toLowerCase(), Number(e.id));

      const incomingNight = e.nightSurcharge === false ? 0 : 1;
      const incomingReason = incomingNight ? null : (String(e.nightSurchargeReason || '').slice(0, 300) || null);
      let salary, nightSurcharge, reason, countDays;
      const incomingCountDays = e.countWorkedDays === true ? 1 : 0;
      if (canPayroll) {
        salary = Number(e.salary) || 0;
        nightSurcharge = incomingNight;
        reason = incomingReason;
        countDays = incomingCountDays;
      } else {
        countDays = prev ? (prev.count_worked_days === 1 ? 1 : 0) : 0;
        if (incomingCountDays !== countDays && e.countWorkedDays !== undefined) payrollIgnored = true;
        // Sin permiso de nomina: salario y recargo nocturno no se tocan
        // (nuevo colaborador: salario minimo de la organizacion y con recargo).
        salary = prev ? prev.salary : defaultSalary;
        nightSurcharge = prev ? (prev.night_surcharge === 0 ? 0 : 1) : 1;
        reason = prev ? prev.night_surcharge_reason : null;
        const salaryChanged = e.salary !== undefined && Number(e.salary) !== Number(salary);
        if (salaryChanged || incomingNight !== nightSurcharge) payrollIgnored = true;
      }
      upsert.run(e.id, orgId, String(e.name || '').slice(0, 120), String(e.role || '').slice(0, 120), e.department || null, e.departmentId || null, salary, nightSurcharge, reason, email || null, countDays);
      // Trazabilidad: activar/desactivar el conteo de dias laborados.
      const prevCount = prev ? (prev.count_worked_days === 1 ? 1 : 0) : 0;
      if (prevCount !== countDays) {
        logAction({
          organizationId: orgId, userId: req.user.id, action: 'employee.count_worked_days_changed',
          resourceType: 'employee', resourceId: String(e.id), ip: getClientIp(req),
          metadata: { employeeName: e.name, contabiliza: !!countDays },
        });
      }

      // Trazabilidad: cada cambio del recargo nocturno queda en la auditoria.
      const prevValue = prev ? (prev.night_surcharge === 0 ? 0 : 1) : 1;
      if ((prev && prevValue !== nightSurcharge) || (!prev && nightSurcharge === 0)) {
        logAction({
          organizationId: orgId, userId: req.user.id, action: 'employee.night_surcharge_changed',
          resourceType: 'employee', resourceId: String(e.id), ip: getClientIp(req),
          metadata: { employeeName: e.name, aplica: !!nightSurcharge, motivo: reason },
        });
      }
    }
    if (payrollIgnored) ignored.push('cambios de salario, recargo nocturno o conteo de dias laborados: requiere permiso de nomina');
  }
  if (Array.isArray(body.shifts)) {
    if (canShifts) {
      db.prepare('DELETE FROM shifts WHERE organization_id = ?').run(orgId);
      const insert = db.prepare('INSERT INTO shifts (id, organization_id, data_json) VALUES (?, ?, ?)');
      for (const sh of body.shifts) {
        const id = sh.id || `${sh.empId}_${sh.date}_${uid('s')}`;
        insert.run(id, orgId, JSON.stringify(sh));
      }
    } else {
      ignored.push('cambios en turnos: requiere permiso de editar turnos');
    }
  }
  // Usuarios y colaboradores con el mismo correo quedan vinculados solos.
  const linked = Array.isArray(body.employees) ? autoLinkByEmail(orgId) : [];
  for (const l of linked) {
    logAction({ organizationId: orgId, userId: req.user.id, action: 'user.auto_linked', resourceType: 'user', ip: getClientIp(req), metadata: l });
  }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'org_data.sync', ip: getClientIp(req), metadata: { employees: (body.employees || []).length, shifts: (body.shifts || []).length, ignored } });
  sendJson(res, 200, { ok: true, ignored, linked });
}

// ---------------------------------------------------------------------------
// Org-scoped user management (organization admins manage only their own org)
// ---------------------------------------------------------------------------
function listOrgUsers(req, res) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'Solo disponible para cuentas de organizacion.' });
  const rows = db.prepare(`
    SELECT u.id, u.email, u.status, u.created_at, u.employee_id AS employeeId, e.name AS employeeName
    FROM users u LEFT JOIN employees e ON e.id = u.employee_id AND e.organization_id = u.organization_id
    WHERE u.organization_id = ?`).all(orgId);
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
  const link = resolveEmployeeLink(orgId, body.employeeId, null);
  if (link.error) return sendJson(res, 400, { error: link.error });

  const userId = uid('user');
  db.prepare(`INSERT INTO users (id, organization_id, email, status, employee_id) VALUES (?, ?, ?, 'invited', ?)`).run(userId, orgId, email, link.employeeId);
  const token = randomToken(32);
  db.prepare(`INSERT INTO invitations (id, organization_id, email, role_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?, datetime('now', '+3 days'), ?)`)
    .run(uid('inv'), orgId, email, role.id, sha256Hex(token), req.user.id);
  const mail = await sendMail({ to: email, subject: `Invitacion a tu organizacion`, kind: 'invitation', link: `/accept-invite.html?token=${token}` });
  // Si no se eligio colaborador, se busca uno con el MISMO correo.
  let linkedEmployeeName = null;
  if (link.employeeId == null) {
    const auto = autoLinkByEmail(orgId).find(l => l.email === email);
    if (auto) linkedEmployeeName = auto.employeeName;
  } else {
    const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(link.employeeId);
    linkedEmployeeName = emp ? emp.name : null;
  }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'user.invite', resourceType: 'user', resourceId: userId, ip: getClientIp(req), metadata: { email, role: roleName, employee: linkedEmployeeName } });
  sendJson(res, 201, { ok: true, inviteLink: mail.link, linkedEmployeeName, note: 'El enlace de invitacion tambien se imprimio en la consola del servidor.' });
}

// Valida el colaborador a vincular con un usuario: debe ser de la misma
// organizacion y no estar ya vinculado a otro usuario. Devuelve el id (o null
// para desvincular) o un mensaje de error.
function resolveEmployeeLink(orgId, rawEmployeeId, exceptUserId) {
  if (rawEmployeeId === null || rawEmployeeId === '' || rawEmployeeId === undefined) return { employeeId: null };
  const employeeId = Number(rawEmployeeId);
  const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND organization_id = ?').get(employeeId, orgId);
  if (!emp) return { error: 'El colaborador seleccionado no existe en esta organizacion.' };
  const taken = db.prepare('SELECT email FROM users WHERE employee_id = ? AND organization_id = ? AND id != ?').get(employeeId, orgId, exceptUserId || '');
  if (taken) return { error: `Ese colaborador ya esta vinculado al usuario ${taken.email}.` };
  return { employeeId };
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
  if (Object.prototype.hasOwnProperty.call(body, 'employeeId')) {
    const link = resolveEmployeeLink(req.user.organizationId, body.employeeId, target.id);
    if (link.error) return sendJson(res, 400, { error: link.error });
    db.prepare(`UPDATE users SET employee_id = ?, updated_at = datetime('now') WHERE id = ?`).run(link.employeeId, target.id);
  }
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
