'use strict';
const { db, uid, seedDemoDataForOrg, getOrgRoleByName } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { describeAudit } = require('../lib/audit-describe');
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

// ---- Cuadro de turnos: publicacion ----
// Rangos publicados de la organizacion.
function getPublications(orgId) {
  return db.prepare(`SELECT p.id, p.date_from AS "from", p.date_to AS "to", p.published_at AS publishedAt, p.notified, u.email AS publishedBy
    FROM shift_publications p LEFT JOIN users u ON u.id = p.published_by
    WHERE p.organization_id = ? ORDER BY p.date_from`).all(orgId);
}
function isDatePublished(pubs, date) {
  return pubs.some(p => p.from <= date && date <= p.to);
}
// Texto legible de un turno (para el historial y los correos).
const ABSENCE_LABELS = { vacaciones: 'Vacaciones', incapacidad: 'Incapacidad', sin_horario: 'Sin horario' };
function shiftSummary(sh) {
  if (!sh) return 'Descanso';
  if (sh.absenceType && ABSENCE_LABELS[sh.absenceType]) return ABSENCE_LABELS[sh.absenceType];
  if (sh.isOffDay) return 'Descanso';
  const time = sh.isSplit && sh.splitOut && sh.splitIn
    ? `${sh.startTime}-${sh.splitOut} / ${sh.splitIn}-${sh.endTime}`
    : `${sh.startTime} - ${sh.endTime}`;
  return sh.functionTag ? `${time} (${sh.functionTag})` : time;
}
const DAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${DAY_NAMES_ES[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
// Correo del colaborador: el de su ficha o el de su usuario vinculado.
function employeeEmail(orgId, empId) {
  const e = db.prepare('SELECT email FROM employees WHERE id = ? AND organization_id = ?').get(empId, orgId);
  if (e && e.email) return e.email;
  const u = db.prepare("SELECT email FROM users WHERE employee_id = ? AND organization_id = ? AND status != 'inactive'").get(empId, orgId);
  return u ? u.email : null;
}
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  let employees = db.prepare('SELECT id, name, role, department, department_id as departmentId, salary, night_surcharge, night_surcharge_reason, email, count_worked_days, document_type, document_number, status, retired_at, retire_reason, retire_detail FROM employees WHERE organization_id = ?').all(orgId)
    .map(({ night_surcharge, night_surcharge_reason, email, count_worked_days, document_type, document_number, status, retired_at, retire_reason, retire_detail, ...e }) => ({ ...e, email: email || '', nightSurcharge: night_surcharge !== 0, nightSurchargeReason: night_surcharge_reason || '', countWorkedDays: count_worked_days === 1, documentType: document_type || 'CC', documentNumber: document_number || '',
      status: status === 'retirado' ? 'retirado' : 'activo', retiredAt: retired_at || null, retireReason: retire_reason || null, retireDetail: retire_detail || null }));
  // Usuario de la suite vinculado a cada colaborador (solo para quien gestiona usuarios).
  if (can(req, 'users.view')) {
    const linkedUsers = new Map(db.prepare('SELECT employee_id, email, status FROM users WHERE organization_id = ? AND employee_id IS NOT NULL').all(orgId)
      .map(u => [Number(u.employee_id), { email: u.email, status: u.status }]));
    employees = employees.map(e => ({ ...e, linkedUser: linkedUsers.get(Number(e.id)) || null }));
  }
  // VENTANA DE TURNOS: el navegador recibe solo los turnos desde el dia 1 del
  // mes de hace dos meses en adelante. Los anteriores se piden aparte
  // (/api/org/shifts) solo cuando alguien navega a esas semanas o liquida
  // ese periodo. Asi la suite pesa lo mismo el primer mes que en el ano cinco.
  const shiftsFrom = defaultShiftsWindowFrom();
  let shifts = readShiftsRange(orgId, shiftsFrom, null);

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
  // Empleado: SOLO ve en "Mi horario" los dias PUBLICADOS.
  const publications = getPublications(orgId);
  if (scope === 'self') {
    shifts = shifts.filter(sh => isDatePublished(publications, sh.date));
  }
  // Salarios y datos de nomina solo para quien puede ver reportes/nomina.
  const canSeePayroll = can(req, 'reports.view');
  if (!canSeePayroll) {
    employees = employees.map(({ salary, nightSurchargeReason, ...e }) => e);
  }

  sendJson(res, 200, {
    organizationId: orgId,
    orgSettings: settingsRow
      ? { orgName: settingsRow.org_name, logo: settingsRow.logo_base64, minimumWage: settingsRow.minimum_wage, includeSundayHoliday: settingsRow.include_sunday_holiday === 1, dayZero: settingsRow.day_zero || null, dayZeroLocked: hasActiveClosures(orgId) }
      : { orgName: 'Empresa', logo: null, minimumWage: 1750905, includeSundayHoliday: false, dayZero: null, dayZeroLocked: false },
    orgNit: (db.prepare('SELECT nit FROM organizations WHERE id = ?').get(orgId) || {}).nit || '',
    openingBalances: canSeePayroll ? listOpeningBalances(orgId) : [],
    departments,
    shiftPresets: presetRows.map(r => JSON.parse(r.data_json)),
    rotationPatterns: scope === 'all' ? db.prepare('SELECT data_json FROM rotation_patterns WHERE organization_id = ?').all(orgId).map(r => JSON.parse(r.data_json)) : [],
    publications: scope === 'all' ? publications : publications.map(p => ({ from: p.from, to: p.to })),
    employees,
    shifts,
    viewer: { scope, employeeId: selfEmployeeId, canSeePayroll },
    dataVersion: getDataVersion(orgId),
    shiftsFrom,
    dataRetention: getRetentionInfo(orgId),
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
  bumpDataVersion(orgId);
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
  // Liquidar recargos dominicales y festivos: desactivado por defecto.
  const includeSundayHoliday = body.includeSundayHoliday !== undefined
    ? (body.includeSundayHoliday ? 1 : 0)
    : (current && current.include_sunday_holiday === 1 ? 1 : 0);
  db.prepare(`
    INSERT INTO org_settings (organization_id, org_name, logo_base64, minimum_wage, include_sunday_holiday, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(organization_id) DO UPDATE SET org_name = excluded.org_name, logo_base64 = excluded.logo_base64, minimum_wage = excluded.minimum_wage,
      include_sunday_holiday = excluded.include_sunday_holiday, updated_at = datetime('now')
  `).run(orgId, orgName, logo, minimumWage, includeSundayHoliday);
  const cambios = [];
  if (!current || current.org_name !== orgName) cambios.push({ campo: 'Nombre de la organización', antes: current ? current.org_name : null, despues: orgName });
  if (current && (current.logo_base64 || null) !== (logo || null)) cambios.push({ campo: 'Logo', antes: current.logo_base64 ? 'con logo' : 'sin logo', despues: logo ? 'logo nuevo' : 'sin logo' });
  if (current && Number(current.minimum_wage) !== Number(minimumWage)) cambios.push({ campo: 'Salario mínimo', antes: current.minimum_wage, despues: minimumWage });
  if ((current ? current.include_sunday_holiday === 1 : false) !== !!includeSundayHoliday) cambios.push({ campo: 'Recargos dominicales y festivos', antes: current && current.include_sunday_holiday === 1 ? 'activos' : 'inactivos', despues: includeSundayHoliday ? 'activos' : 'inactivos' });
  if (cambios.length) logAction({ organizationId: orgId, userId: req.user.id, action: 'settings.update', ip: getClientIp(req), metadata: { cambios } });
  sendJson(res, 200, { ok: true });
}

async function replaceDepartments(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const list = Array.isArray(body.departments) ? body.departments : [];
  const beforeDepts = new Map(db.prepare('SELECT id, name FROM departments WHERE organization_id = ?').all(orgId).map(d => [String(d.id), d.name]));
  db.prepare('DELETE FROM departments WHERE organization_id = ?').run(orgId);
  const insert = db.prepare('INSERT INTO departments (id, organization_id, name, icon, position) VALUES (?, ?, ?, ?, ?)');
  list.forEach((d, idx) => {
    insert.run(String(d.id || uid('dept')), orgId, String(d.name || '').slice(0, 80), String(d.icon || 'fa-briefcase'), idx);
  });
  const afterDepts = new Map(list.map(d => [String(d.id), String(d.name || '')]));
  const agregadas = [...afterDepts].filter(([id]) => !beforeDepts.has(id)).map(([, n]) => n);
  const eliminadas = [...beforeDepts].filter(([id]) => !afterDepts.has(id)).map(([, n]) => n);
  const renombradas = [...afterDepts].filter(([id, n]) => beforeDepts.has(id) && beforeDepts.get(id) !== n).map(([id, n]) => ({ antes: beforeDepts.get(id), despues: n }));
  const orden = [...beforeDepts.keys()].filter(id => afterDepts.has(id)).join() !== [...afterDepts.keys()].filter(id => beforeDepts.has(id)).join();
  if (agregadas.length || eliminadas.length || renombradas.length || orden) {
    logAction({ organizationId: orgId, userId: req.user.id, action: 'departments.replace', ip: getClientIp(req), metadata: { agregadas, eliminadas, renombradas, ordenCambiado: orden } });
  }
  sendJson(res, 200, { ok: true });
}

async function replaceShiftPresets(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const list = Array.isArray(body.shiftPresets) ? body.shiftPresets : [];
  const presetText = (p) => `${p.name} (${p.isSplit && p.splitOut ? `${p.startTime}-${p.splitOut} / ${p.splitIn}-${p.endTime}` : `${p.startTime}-${p.endTime}`})`;
  const beforePresets = new Map(db.prepare('SELECT id, data_json FROM shift_presets WHERE organization_id = ?').all(orgId).map(r => { try { return [String(r.id), JSON.parse(r.data_json)]; } catch { return [String(r.id), {}]; } }));
  db.prepare('DELETE FROM shift_presets WHERE organization_id = ?').run(orgId);
  const insert = db.prepare('INSERT INTO shift_presets (id, organization_id, data_json) VALUES (?, ?, ?)');
  list.forEach((p) => insert.run(String(p.id || uid('preset')), orgId, JSON.stringify(p)));
  const afterPresets = new Map(list.map(p => [String(p.id), p]));
  const creados = [...afterPresets].filter(([id]) => !beforePresets.has(id)).map(([, p]) => presetText(p));
  const eliminados = [...beforePresets].filter(([id]) => !afterPresets.has(id)).map(([, p]) => presetText(p));
  const editados = [...afterPresets].filter(([id, p]) => beforePresets.has(id) && presetText(beforePresets.get(id)) + (beforePresets.get(id).color || '') + (beforePresets.get(id).functionTag || '') !== presetText(p) + (p.color || '') + (p.functionTag || ''))
    .map(([id, p]) => ({ antes: presetText(beforePresets.get(id)), despues: presetText(p) }));
  if (creados.length || eliminados.length || editados.length) {
    logAction({ organizationId: orgId, userId: req.user.id, action: 'shift_presets.replace', ip: getClientIp(req), metadata: { creados, editados, eliminados } });
  }
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
  try { body = await readBody(req, 30 * 1024 * 1024); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });

  // Control de version: solo se acepta el guardado si se hizo sobre la version
  // ACTUAL de los datos. Si otra pestana u otro usuario guardo despues, se
  // rechaza (en vez de sobrescribir esos cambios con una copia vieja).
  const currentVersion = getDataVersion(orgId);
  if (body.baseVersion === undefined || Number(body.baseVersion) !== currentVersion) {
    return sendJson(res, 409, { error: 'Otro usuario (u otra pestaña) guardó cambios después de que abriste la suite. Recarga para ver la versión actual.', conflict: true, currentVersion });
  }
  // Desde que fecha tiene el navegador los turnos cargados (ventana de turnos).
  const windowFrom = String(body.shiftsFrom || '');
  if (Array.isArray(body.shifts) && !/^\d{4}-\d{2}-\d{2}$/.test(windowFrom)) {
    return sendJson(res, 400, { error: 'Recarga la suite para guardar (versión anterior de la página).' });
  }
  db.exec('BEGIN');
  try {
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
      db.prepare('SELECT id, name, role, department, salary, night_surcharge, night_surcharge_reason, email, count_worked_days, document_type, document_number, status FROM employees WHERE organization_id = ?').all(orgId).map(r => [Number(r.id), r])
    );
    const incomingIds = new Set(body.employees.map(e => Number(e.id)));
    const toDelete = [...existing.keys()].filter(id => !incomingIds.has(id));
    if (toDelete.length) {
      if (canDelete) {
        const del = db.prepare('DELETE FROM employees WHERE organization_id = ? AND id = ?');
        for (const id of toDelete) {
          // PROTECCION DEL HISTORIAL: si el colaborador ya tiene marcaciones,
          // alertas, cierres u otros registros, NO se borra: se retira (se
          // conserva toda su evidencia). Solo se borran fichas sin historial.
          if (employeeHasHistory(orgId, id)) {
            if (existing.get(id).status !== 'retirado') {
              retireEmployeeRecord(orgId, id, { date: bogotaToday(), reason: 'Otro', detail: 'Quitado de la lista de colaboradores (se conserva su historial).', userId: req.user.id, deactivateUser: false, ip: getClientIp(req), auto: true });
            }
            continue;
          }
          deleteEmployeeCompletely(orgId, id);
          logAction({ organizationId: orgId, userId: req.user.id, action: 'employee.deleted', resourceType: 'employee', resourceId: String(id), ip: getClientIp(req), metadata: { colaborador: existing.get(id).name } });
        }
      } else {
        ignored.push(`eliminar ${toDelete.length} colaborador(es): requiere permiso de eliminar colaboradores`);
      }
    }
    const settingsRow = db.prepare('SELECT minimum_wage FROM org_settings WHERE organization_id = ?').get(orgId);
    const defaultSalary = (settingsRow && settingsRow.minimum_wage) || 1750905;
    const upsert = db.prepare(`
      INSERT INTO employees (id, organization_id, name, role, department, department_id, salary, night_surcharge, night_surcharge_reason, email, count_worked_days, document_type, document_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, department = excluded.department, department_id = excluded.department_id, salary = excluded.salary,
        night_surcharge = excluded.night_surcharge, night_surcharge_reason = excluded.night_surcharge_reason, email = excluded.email, count_worked_days = excluded.count_worked_days,
        document_type = excluded.document_type, document_number = excluded.document_number
    `);
    let payrollIgnored = false;
    // Correos ya usados por colaboradores que NO vienen en la lista (y se conservan).
    const usedEmails = new Map();
    const usedDocs = new Map();
    for (const [id, r] of existing) {
      if (!incomingIds.has(id) && !canDelete && r.email) usedEmails.set(String(r.email).toLowerCase(), id);
      if (!incomingIds.has(id) && !canDelete && r.document_number) usedDocs.set(`${r.document_type || 'CC'}:${r.document_number}`, id);
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

      // Documento de identidad (opcional): tipo valido, numero con formato y unico.
      const DOC_TYPES = ['CC', 'CE', 'PPT', 'PA', 'TI'];
      let docType = DOC_TYPES.includes(String(e.documentType || '').toUpperCase()) ? String(e.documentType).toUpperCase() : 'CC';
      let docNumber = String(e.documentNumber || '').replace(/[\s.]/g, '').toUpperCase().slice(0, 20) || null;
      if (docNumber) {
        const okFormat = ['CC', 'TI'].includes(docType) ? /^\d{3,12}$/.test(docNumber) : /^[A-Z0-9-]{3,20}$/.test(docNumber);
        if (!okFormat) {
          ignored.push(`documento no valido para "${String(e.name || '').slice(0, 60)}"`);
          docType = prev ? (prev.document_type || 'CC') : 'CC'; docNumber = prev ? prev.document_number : null;
        } else {
          const key = `${docType}:${docNumber}`;
          if (usedDocs.has(key) && usedDocs.get(key) !== Number(e.id)) {
            ignored.push(`el documento ${docType} ${docNumber} ya pertenece a otro colaborador`);
            docType = prev ? (prev.document_type || 'CC') : 'CC'; docNumber = prev ? prev.document_number : null;
          }
        }
      }
      if (docNumber) usedDocs.set(`${docType}:${docNumber}`, Number(e.id));

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
      const newName = String(e.name || '').slice(0, 120), newRole = String(e.role || '').slice(0, 120);
      upsert.run(e.id, orgId, newName, newRole, e.department || null, e.departmentId || null, salary, nightSurcharge, reason, email || null, countDays, docNumber ? docType : null, docNumber);
      // Auditoria: que se creo o que cambio exactamente en la ficha.
      if (!prev) {
        logAction({ organizationId: orgId, userId: req.user.id, action: 'employee.created', resourceType: 'employee', resourceId: String(e.id), ip: getClientIp(req),
          metadata: { colaborador: newName, cargo: newRole, area: e.department || null, salario: salary, documento: docNumber ? `${docType} ${docNumber}` : null, correo: email || null } });
      } else {
        const cambios = [];
        const chk = (campo, a, b) => { if ((a == null ? '' : String(a)) !== (b == null ? '' : String(b))) cambios.push({ campo, antes: a == null || a === '' ? null : a, despues: b == null || b === '' ? null : b }); };
        chk('Nombre', prev.name, newName);
        chk('Cargo', prev.role, newRole);
        chk('Área', prev.department, e.department || null);
        chk('Salario', Number(prev.salary), Number(salary));
        chk('Correo', prev.email, email || null);
        chk('Documento', prev.document_number ? `${prev.document_type || 'CC'} ${prev.document_number}` : null, docNumber ? `${docType} ${docNumber}` : null);
        if (cambios.length) logAction({ organizationId: orgId, userId: req.user.id, action: 'employee.updated', resourceType: 'employee', resourceId: String(e.id), ip: getClientIp(req), metadata: { colaborador: newName, cambios } });
      }
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
  let shiftChanges = [];
  if (Array.isArray(body.shifts)) {
    if (canShifts) {
      // Diferencias de turnos (todos los dias): para la auditoria, y los de
      // dias YA PUBLICADOS ademas se registran y se avisan al colaborador.
      const pubs = getPublications(orgId);
      const keyOf = (sh) => `${Number(sh.empId)}|${sh.date}`;
      const beforeAll = new Map();
      for (const sh of readShiftsRange(orgId, windowFrom, null)) beforeAll.set(keyOf(sh), sh);
      const afterAll = new Map();
      for (const sh of body.shifts) { if (sh && sh.date >= windowFrom) afterAll.set(keyOf(sh), sh); }
      const auditByEmp = new Map();
      for (const k of new Set([...beforeAll.keys(), ...afterAll.keys()])) {
        const b = shiftSummary(beforeAll.get(k)), a = shiftSummary(afterAll.get(k));
        if (b === a) continue;
        const [empId, date] = k.split('|');
        if (!auditByEmp.has(empId)) auditByEmp.set(empId, []);
        auditByEmp.get(empId).push({ fecha: date, antes: b, despues: a });
        if (pubs.length && isDatePublished(pubs, date)) shiftChanges.push({ employeeId: Number(empId), date, before: b, after: a });
      }
      for (const [empId, list] of auditByEmp) {
        list.sort((x, y) => x.fecha.localeCompare(y.fecha));
        const emp = db.prepare('SELECT name FROM employees WHERE id = ? AND organization_id = ?').get(Number(empId), orgId);
        logAction({ organizationId: orgId, userId: req.user.id, action: 'shifts.changed', resourceType: 'employee', resourceId: String(empId), ip: getClientIp(req),
          metadata: { colaborador: emp ? emp.name : `Colaborador ${empId}`, total: list.length, cambios: list.slice(0, 120) } });
      }
      // Solo se reemplazan los turnos de la ventana que el navegador tiene
      // cargada (desde windowFrom); los anteriores no se tocan.
      db.prepare("DELETE FROM shifts WHERE organization_id = ? AND json_extract(data_json, '$.date') >= ?").run(orgId, windowFrom);
      const insert = db.prepare('INSERT INTO shifts (id, organization_id, data_json) VALUES (?, ?, ?)');
      const purgeCutoff = retentionCutoff(orgId);
      // Colaboradores retirados: no se aceptan turnos posteriores a su fecha de retiro.
      const retiredAt = new Map(db.prepare("SELECT id, retired_at FROM employees WHERE organization_id = ? AND status = 'retirado'").all(orgId).map(r => [Number(r.id), r.retired_at]));
      for (const sh of body.shifts) {
        if (!sh || !sh.date || sh.date < windowFrom) continue;
        if (purgeCutoff && sh.date < purgeCutoff) continue; // ya depurado: no se vuelve a crear
        const rAt = retiredAt.get(Number(sh.empId));
        if (rAt && sh.date > rAt) continue;
        const id = sh.id || `${sh.empId}_${sh.date}_${uid('s')}`;
        insert.run(id, orgId, JSON.stringify(sh));
      }
    } else {
      ignored.push('cambios en turnos: requiere permiso de editar turnos');
    }
  }
  if (shiftChanges.length) {
    const insChange = db.prepare(`INSERT INTO shift_changes (id, organization_id, employee_id, shift_date, before_text, after_text, changed_by, notified)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const byEmp = new Map();
    for (const c of shiftChanges) {
      const email = employeeEmail(orgId, c.employeeId);
      insChange.run(uid('chg'), orgId, c.employeeId, c.date, c.before, c.after, req.user.id, email ? 1 : 0);
      if (email) { if (!byEmp.has(email)) byEmp.set(email, []); byEmp.get(email).push(c); }
    }
    // Un solo correo por colaborador con todos sus cambios (no se espera la respuesta).
    for (const [email, list] of byEmp) {
      list.sort((x, y) => x.date.localeCompare(y.date));
      const lines = list.map(c => `${dayLabel(c.date)}: ${c.before} -> ${c.after}`);
      sendMail({
        to: email, kind: 'shift_change', link: '/app.html',
        subject: 'Se modificó tu horario de trabajo',
        bodyText: `Hola. Se modificó tu horario ya publicado:\n\n${lines.join('\n')}\n\nRevísalo en la suite, en "Mi horario y marcaciones".`,
        bodyHtml: `<p>Hola. Se modificó tu horario ya publicado:</p><ul>${list.map(c => `<li><strong>${escHtml(dayLabel(c.date))}:</strong> ${escHtml(c.before)} &rarr; <strong>${escHtml(c.after)}</strong></li>`).join('')}</ul><p>Revísalo en la suite, en "Mi horario y marcaciones".</p>`,
      }).catch(() => {});
    }
  }
  // Usuarios y colaboradores con el mismo correo quedan vinculados solos.
  const linked = Array.isArray(body.employees) ? autoLinkByEmail(orgId) : [];
  for (const l of linked) {
    logAction({ organizationId: orgId, userId: req.user.id, action: 'user.auto_linked', resourceType: 'user', ip: getClientIp(req), metadata: l });
  }
  if (ignored.length) logAction({ organizationId: orgId, userId: req.user.id, action: 'org_data.ignored', ip: getClientIp(req), metadata: { ignorados: ignored } });
  const newVersion = bumpDataVersion(orgId);
  db.exec('COMMIT');
  sendJson(res, 200, { ok: true, ignored, linked, shiftChanges: shiftChanges.length, dataVersion: newVersion });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ya cerrada */ }
    throw e;
  }
}

// ---- Ventana de turnos y depuracion ----
function defaultShiftsWindowFrom() {
  const today = new Date(Date.now() - 5 * 3600000);
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1));
  return d.toISOString().slice(0, 10);
}
// Turnos de un rango de fechas (to = null: sin limite superior).
function readShiftsRange(orgId, from, to) {
  const rows = to
    ? db.prepare("SELECT data_json FROM shifts WHERE organization_id = ? AND json_extract(data_json, '$.date') >= ? AND json_extract(data_json, '$.date') <= ?").all(orgId, from, to)
    : db.prepare("SELECT data_json FROM shifts WHERE organization_id = ? AND json_extract(data_json, '$.date') >= ?").all(orgId, from);
  const out = [];
  for (const r of rows) { try { out.push(JSON.parse(r.data_json)); } catch { /* fila invalida */ } }
  return out;
}

// GET /api/org/shifts?from=&to=  -- turnos anteriores a la ventana, bajo demanda.
function getShiftsRange(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '0000-01-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : null;
  let shifts = readShiftsRange(orgId, from, to);
  const scope = (can(req, 'employees.view') || can(req, 'shifts.view')) ? 'all' : 'self';
  if (scope === 'self') {
    const selfId = req.user.employeeId != null ? Number(req.user.employeeId) : null;
    const pubs = getPublications(orgId);
    shifts = selfId == null ? [] : shifts.filter(sh => Number(sh.empId) === selfId && isDatePublished(pubs, sh.date));
  }
  sendJson(res, 200, { from, to, shifts });
}

function retentionCutoff(orgId) {
  const r = db.prepare('SELECT shift_retention_years FROM org_settings WHERE organization_id = ?').get(orgId);
  const years = r && Number(r.shift_retention_years);
  if (!years || years < 3) return null;
  const today = new Date(Date.now() - 5 * 3600000);
  return new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
}
function getRetentionInfo(orgId) {
  const r = db.prepare('SELECT shift_retention_years, shift_purge_info FROM org_settings WHERE organization_id = ?').get(orgId) || {};
  let last = null; try { last = r.shift_purge_info ? JSON.parse(r.shift_purge_info) : null; } catch { last = null; }
  return { years: r.shift_retention_years || null, cutoff: retentionCutoff(orgId), last };
}

// Depura (borra) los turnos mas antiguos que el plazo configurado. Se ejecuta
// sola una vez al dia. Solo la programacion de turnos: las marcaciones, los
// cierres y la auditoria no se tocan.
function purgeOldShifts(orgId, userId = null) {
  const cutoff = retentionCutoff(orgId);
  if (!cutoff) return 0;
  const n = db.prepare("DELETE FROM shifts WHERE organization_id = ? AND json_extract(data_json, '$.date') < ?").run(orgId, cutoff).changes;
  const info = { at: new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 16).replace('T', ' '), cutoff, deleted: n };
  db.prepare('UPDATE org_settings SET shift_purge_info = ? WHERE organization_id = ?').run(JSON.stringify(info), orgId);
  if (n) logAction({ organizationId: orgId, userId, action: 'shifts.purged', resourceType: 'organization', resourceId: orgId, ip: null, metadata: { turnos: n, antesDe: cutoff } });
  return n;
}
let lastPurgeDay = null;
const purgeTimer = setInterval(() => {
  const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  if (lastPurgeDay === today) return;
  lastPurgeDay = today;
  try {
    for (const o of db.prepare('SELECT organization_id AS id FROM org_settings WHERE shift_retention_years IS NOT NULL').all()) purgeOldShifts(o.id);
  } catch (e) { console.error('[turnos] Depuración:', e.message); }
}, 60 * 60 * 1000);
if (purgeTimer.unref) purgeTimer.unref();

// PUT /api/org/data-retention  { years: null | 3 | 5 | 10 }
async function saveDataRetention(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const years = body.years == null || body.years === '' ? null : Number(body.years);
  if (years !== null && ![3, 5, 10].includes(years)) return sendJson(res, 400, { error: 'El plazo debe ser 3, 5 o 10 años (o desactivado).' });
  if (!db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId)) db.prepare("INSERT INTO org_settings (organization_id, org_name) VALUES (?, 'Empresa')").run(orgId);
  const prev = getRetentionInfo(orgId).years;
  db.prepare('UPDATE org_settings SET shift_retention_years = ? WHERE organization_id = ?').run(years, orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'settings.shift_retention', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req), metadata: { antes: prev, despues: years } });
  const deleted = years ? purgeOldShifts(orgId, req.user.id) : 0;
  sendJson(res, 200, { ok: true, deleted, ...getRetentionInfo(orgId) });
}

function getDataVersion(orgId) {
  const r = db.prepare('SELECT data_version FROM org_settings WHERE organization_id = ?').get(orgId);
  return r ? Number(r.data_version) || 0 : 0;
}
function bumpDataVersion(orgId) {
  if (!db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId)) {
    db.prepare("INSERT INTO org_settings (organization_id, org_name) VALUES (?, 'Empresa')").run(orgId);
  }
  db.prepare('UPDATE org_settings SET data_version = data_version + 1 WHERE organization_id = ?').run(orgId);
  return getDataVersion(orgId);
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
  const metaUpd = { usuario: target.email };
  if (body.role) metaUpd.rolNuevo = body.role;
  if (Object.prototype.hasOwnProperty.call(body, 'employeeId')) {
    const emp = body.employeeId ? db.prepare('SELECT name FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), req.user.organizationId) : null;
    metaUpd.colaboradorVinculado = emp ? emp.name : null;
  }
  logAction({ organizationId: req.user.organizationId, userId: req.user.id, action: 'user.update', resourceType: 'user', resourceId: target.id, ip: getClientIp(req), metadata: metaUpd });
  sendJson(res, 200, { ok: true });
}

function toggleOrgUserStatus(req, res, params) {
  const target = assertOrgUserOwnership(req, res, params.id);
  if (!target) return;
  const newStatus = target.status === 'active' ? 'inactive' : 'active';
  db.prepare(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(newStatus, target.id);
  logAction({ organizationId: req.user.organizationId, userId: req.user.id, action: newStatus === 'active' ? 'user.activate' : 'user.deactivate', resourceType: 'user', resourceId: target.id, ip: getClientIp(req), metadata: { usuario: target.email } });
  sendJson(res, 200, { ok: true, status: newStatus });
}

async function resetOrgUserPassword(req, res, params) {
  const target = assertOrgUserOwnership(req, res, params.id);
  if (!target) return;
  const token = randomToken(32);
  db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(uid('pwr'), target.id, sha256Hex(token));
  const mail = await sendMail({ to: target.email, subject: 'Restablecimiento de contrasena', kind: 'password_reset', link: `/reset-password.html?token=${token}` });
  logAction({ organizationId: req.user.organizationId, userId: req.user.id, action: 'user.reset_password_requested', resourceType: 'user', resourceId: target.id, ip: getClientIp(req), metadata: { usuario: target.email } });
  sendJson(res, 200, { ok: true, resetLink: mail.link });
}

// GET /api/org/audit?from=&to=&userId=&category=&q=
// Cada registro se devuelve con su descripcion en español (que hizo, sobre
// quien y con que detalle), quien lo hizo (correo y rol) y su categoria.
function listOrgAudit(req, res, query = {}) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'Solo disponible para cuentas de organizacion.' });
  const from = ISO_DATE.test(query.from || '') ? query.from : addDaysISO(bogotaToday(), -30);
  const to = ISO_DATE.test(query.to || '') ? query.to : bogotaToday();
  const rows = db.prepare(`SELECT * FROM audit_logs WHERE organization_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?
    ${query.userId ? 'AND user_id = ?' : ''} ORDER BY created_at DESC LIMIT 3000`)
    .all(...[orgId, from, to, ...(query.userId ? [query.userId] : [])]);
  const users = new Map(db.prepare(`SELECT u.id, u.email, (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id LIMIT 1) AS role
    FROM users u WHERE u.organization_id = ?`).all(orgId).map(u => [u.id, u]));
  const employees = new Map(db.prepare('SELECT id, name FROM employees WHERE organization_id = ?').all(orgId).map(e => [String(e.id), e.name]));
  const ROLE_ES = { org_admin: 'Administrador', supervisor: 'Supervisor', empleado: 'Empleado' };
  let logs = rows.map(r => {
    const metadata = r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return null; } })() : null;
    const d = describeAudit({ ...r, metadata }, { users, employees });
    const u = r.user_id ? users.get(r.user_id) : null;
    return {
      id: r.id, at: r.created_at, action: r.action, category: d.category, title: d.title, text: d.text, details: d.details || [],
      user: u ? u.email : (d.actorFallback || 'Sistema'), role: u ? (ROLE_ES[u.role] || u.role || '') : '', ip: r.ip,
    };
  });
  if (query.category) logs = logs.filter(l => l.category === query.category);
  if (query.q) { const q = String(query.q).toLowerCase(); logs = logs.filter(l => (l.text + ' ' + l.details.join(' ') + ' ' + l.user).toLowerCase().includes(q)); }
  sendJson(res, 200, {
    from, to, logs: logs.slice(0, 1500), truncated: logs.length > 1500,
    users: [...users.values()].map(u => ({ id: u.id, email: u.email, role: ROLE_ES[u.role] || u.role || '' })),
  });
}

// ---------------------------------------------------------------------------
// Ajustes manuales de la liquidacion (extras y recargos)
// ---------------------------------------------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function listPayrollAdjustments(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  if (!ISO_DATE.test(query.from || '') || !ISO_DATE.test(query.to || '')) return sendJson(res, 400, { error: 'Periodo invalido.' });
  const rows = db.prepare(`
    SELECT a.employee_id AS employeeId, a.hon, a.hed, a.hen, a.total, a.total_manual AS totalManual,
           a.reason, a.updated_at AS updatedAt, u.email AS updatedBy
    FROM payroll_adjustments a LEFT JOIN users u ON u.id = a.updated_by
    WHERE a.organization_id = ? AND a.period_start = ? AND a.period_end = ?
  `).all(orgId, query.from, query.to);
  // Historial de cambios del periodo (desde la auditoria).
  const periodo = JSON.stringify(`${query.from} al ${query.to}`);
  const history = db.prepare(`
    SELECT l.created_at AS at, l.action, l.metadata_json, u.email AS userEmail
    FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.organization_id = ? AND l.action IN ('payroll.adjustment', 'payroll.adjustments_reset')
      AND l.metadata_json LIKE ?
    ORDER BY l.created_at DESC LIMIT 300
  `).all(orgId, `%"periodo":${periodo}%`)
    .map(h => ({ at: h.at, action: h.action, userEmail: h.userEmail, ...(h.metadata_json ? JSON.parse(h.metadata_json) : {}) }));
  sendJson(res, 200, { rows, history });
}

async function savePayrollAdjustment(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const { from, to } = body;
  if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '') || from > to) return sendJson(res, 400, { error: 'Periodo invalido.' });
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo del ajuste (minimo 5 caracteres).' });
  const emp = db.prepare('SELECT id, name FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const hon = num(body.hon), hed = num(body.hed), hen = num(body.hen), total = num(body.total);
  const totalManual = body.totalManual ? 1 : 0;
  db.prepare(`
    INSERT INTO payroll_adjustments (organization_id, employee_id, period_start, period_end, hon, hed, hen, total, total_manual, reason, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))
    ON CONFLICT(organization_id, employee_id, period_start, period_end) DO UPDATE SET
      hon = excluded.hon, hed = excluded.hed, hen = excluded.hen, total = excluded.total, total_manual = excluded.total_manual,
      reason = excluded.reason, updated_by = excluded.updated_by, updated_at = datetime('now', '-5 hours')
  `).run(orgId, emp.id, from, to, hon, hed, hen, total, totalManual, reason, req.user.id);
  const change = body.change && typeof body.change === 'object' ? {
    campo: String(body.change.field || '').slice(0, 20),
    antes: num(body.change.before),
    despues: num(body.change.after),
  } : null;
  logAction({
    organizationId: orgId, userId: req.user.id, action: 'payroll.adjustment',
    resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, periodo: `${from} al ${to}`, ...change, motivo: reason },
  });
  sendJson(res, 200, { ok: true });
}

async function resetPayrollAdjustments(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const { from, to } = body;
  if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '')) return sendJson(res, 400, { error: 'Periodo invalido.' });
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo (minimo 5 caracteres).' });
  const info = db.prepare('DELETE FROM payroll_adjustments WHERE organization_id = ? AND period_start = ? AND period_end = ?').run(orgId, from, to);
  logAction({
    organizationId: orgId, userId: req.user.id, action: 'payroll.adjustments_reset', ip: getClientIp(req),
    metadata: { periodo: `${from} al ${to}`, ajustesEliminados: info.changes, motivo: reason },
  });
  sendJson(res, 200, { ok: true, removed: info.changes });
}

// ---------------------------------------------------------------------------
// CIERRES DE PERIODO (recargos y horas extras por separado)
// ---------------------------------------------------------------------------
const CLOSURE_TYPES = ['recargos', 'extras'];
function closureView(c) {
  // Extras: de que cierre viene el saldo anterior y en que cierre se aplico
  // el saldo que deja este periodo (para verificar el traslado en el PDF).
  let previous = null, next = null;
  if (c.closure_type === 'extras') {
    if (c.previous_closure_id) {
      const p = db.prepare('SELECT period_start, period_end, status FROM payroll_closures WHERE id = ?').get(c.previous_closure_id);
      if (p) previous = { from: p.period_start, to: p.period_end, status: p.status };
    }
    const n = db.prepare(`SELECT period_start, period_end, snapshot_json FROM payroll_closures
      WHERE previous_closure_id = ? AND status = 'cerrado' ORDER BY closed_at DESC LIMIT 1`).get(c.id);
    if (n) {
      const snap = JSON.parse(n.snapshot_json || '{}');
      const carryIn = {};
      (snap.employees || []).forEach(e => { if (e.carryIn) carryIn[e.employeeId] = e.carryIn; });
      next = { from: n.period_start, to: n.period_end, carryIn };
    }
  }
  return {
    previous, next,
    id: c.id, type: c.closure_type, from: c.period_start, to: c.period_end, status: c.status,
    pendingDays: c.pending_days, closedAt: c.closed_at, closedBy: c.closed_by_email || null,
    reopenedAt: c.reopened_at, reopenedBy: c.reopened_by_email || null, reopenReason: c.reopen_reason,
    snapshot: JSON.parse(c.snapshot_json || '{}'),
  };
}
const CLOSURE_SELECT = `
  SELECT c.*, u1.email AS closed_by_email, u2.email AS reopened_by_email
  FROM payroll_closures c
  LEFT JOIN users u1 ON u1.id = c.closed_by
  LEFT JOIN users u2 ON u2.id = c.reopened_by`;
// Ultimo cierre ACTIVO de extras que termina antes de 'from': de ahi sale el
// saldo negativo que se traslada al periodo que empieza en 'from'.
function previousExtrasClosure(orgId, from) {
  return db.prepare(`${CLOSURE_SELECT}
    WHERE c.organization_id = ? AND c.closure_type = 'extras' AND c.status = 'cerrado' AND c.period_end < ?
    ORDER BY c.period_end DESC LIMIT 1`).get(orgId, from) || null;
}

// Recargos: periodos CONTINUOS. El siguiente periodo arranca el dia despues
// del ultimo cierre activo; si nunca se ha cerrado, desde la primera marcacion
// registrada en la organizacion.
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function bogotaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}
function lastRecargosClosure(orgId) {
  return db.prepare(`${CLOSURE_SELECT}
    WHERE c.organization_id = ? AND c.closure_type = 'recargos' AND c.status = 'cerrado'
    ORDER BY c.period_end DESC LIMIT 1`).get(orgId) || null;
}
function nextRecargosStart(orgId) {
  const last = lastRecargosClosure(orgId);
  if (last) return addDaysISO(last.period_end, 1);
  // Con Dia 0 definido, el primer periodo de recargos inicia el dia siguiente.
  const dz = getDayZero(orgId);
  if (dz) return addDaysISO(dz, 1);
  const first = db.prepare('SELECT MIN(shift_date) AS d FROM attendance_days WHERE organization_id = ?').get(orgId);
  return first && first.d ? first.d : null;
}

// ---------------------------------------------------------------------------
// DIA 0 Y SALDOS INICIALES
// ---------------------------------------------------------------------------
function getDayZero(orgId) {
  const r = db.prepare('SELECT day_zero FROM org_settings WHERE organization_id = ?').get(orgId);
  return r && r.day_zero ? r.day_zero : null;
}
function hasActiveClosures(orgId) {
  return !!db.prepare("SELECT 1 FROM payroll_closures WHERE organization_id = ? AND status = 'cerrado' LIMIT 1").get(orgId);
}
// Un saldo inicial queda BLOQUEADO cuando ya se cerro un periodo (de extras o
// de recargos) que incluye el dia siguiente a su fecha de corte.
function openingBalanceLock(orgId, cutoff) {
  const day = addDaysISO(cutoff, 1);
  return db.prepare(`SELECT closure_type, period_start, period_end FROM payroll_closures
    WHERE organization_id = ? AND status = 'cerrado' AND period_start <= ? AND period_end >= ?`).all(orgId, day, day);
}
function listOpeningBalances(orgId) {
  return db.prepare(`SELECT b.employee_id AS employeeId, b.cutoff_date AS cutoff, b.hed, b.hen, b.hon, b.dom, b.note,
      b.updated_at AS updatedAt, u.email AS updatedBy
    FROM employee_opening_balances b LEFT JOIN users u ON u.id = b.updated_by
    WHERE b.organization_id = ?`).all(orgId)
    .map(b => ({ ...b, lockedBy: openingBalanceLock(orgId, b.cutoff).map(c => ({ type: c.closure_type, from: c.period_start, to: c.period_end })) }));
}

// PUT /api/org/day-zero { date }
async function setDayZero(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const date = body.date === null ? null : String(body.date || '');
  if (date !== null && !ISO_DATE.test(date)) return sendJson(res, 400, { error: 'Fecha invalida.' });
  // Con periodos cerrados, el Dia 0 solo puede quedar ANTES de todos ellos
  // (organizaciones que ya liquidaban en la suite antes de existir el Dia 0).
  const firstClosed = db.prepare("SELECT MIN(period_start) AS d FROM payroll_closures WHERE organization_id = ? AND status = 'cerrado'").get(orgId);
  if (firstClosed && firstClosed.d) {
    if (getDayZero(orgId)) return sendJson(res, 409, { error: 'El Dia 0 ya no se puede cambiar porque existen periodos cerrados.' });
    if (!date || date >= firstClosed.d) return sendJson(res, 409, { error: `Ya hay periodos cerrados desde el ${firstClosed.d}. El Dia 0 debe ser anterior a esa fecha.` });
  }
  const tooEarly = date && db.prepare('SELECT employee_id FROM employee_opening_balances WHERE organization_id = ? AND cutoff_date < ? LIMIT 1').get(orgId, date);
  if (tooEarly) return sendJson(res, 409, { error: 'Hay saldos iniciales con fecha de corte anterior a ese Dia 0. Ajustalos primero.' });
  const exists = db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId);
  if (exists) db.prepare(`UPDATE org_settings SET day_zero = ?, updated_at = datetime('now') WHERE organization_id = ?`).run(date, orgId);
  else db.prepare(`INSERT INTO org_settings (organization_id, org_name, day_zero) VALUES (?, 'Empresa', ?)`).run(orgId, date);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'payroll.day_zero_set', ip: getClientIp(req), metadata: { diaCero: date } });
  sendJson(res, 200, { ok: true, dayZero: date });
}

// PUT /api/payroll/opening-balance { employeeId, cutoff, hed, hen, hon, dom, note }
async function saveOpeningBalance(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const dz = getDayZero(orgId);
  if (!dz) return sendJson(res, 400, { error: 'Primero define el Dia 0 de la organizacion.' });
  const emp = db.prepare('SELECT id, name FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  const cutoff = String(body.cutoff || '');
  if (!ISO_DATE.test(cutoff) || cutoff < dz) return sendJson(res, 400, { error: `La fecha de corte debe ser igual o posterior al Dia 0 (${dz}).` });
  const n = (v) => { const x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : NaN; };
  const hed = n(body.hed || 0), hen = n(body.hen || 0), hon = n(body.hon || 0), dom = n(body.dom || 0);
  if ([hed, hen, hon, dom].some(isNaN)) return sendJson(res, 400, { error: 'Valores invalidos.' });
  if (hen < 0 || hon < 0 || dom < 0) return sendJson(res, 400, { error: 'Solo la extra diurna puede ser negativa (tiempo que debe el colaborador).' });
  const note = String(body.note || '').trim().slice(0, 300);
  if (note.length < 5) return sendJson(res, 400, { error: 'Escribe la nota de soporte (minimo 5 caracteres).' });
  const prev = db.prepare('SELECT cutoff_date FROM employee_opening_balances WHERE organization_id = ? AND employee_id = ?').get(orgId, emp.id);
  const locks = [...(prev ? openingBalanceLock(orgId, prev.cutoff_date) : []), ...openingBalanceLock(orgId, cutoff)];
  if (locks.length) return sendJson(res, 409, { error: `El saldo inicial ya se aplico en el cierre de ${locks[0].closure_type} del ${locks[0].period_start} al ${locks[0].period_end}. Para cambiarlo, reabre ese periodo.` });
  db.prepare(`INSERT INTO employee_opening_balances (organization_id, employee_id, cutoff_date, hed, hen, hon, dom, note, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))
    ON CONFLICT(organization_id, employee_id) DO UPDATE SET cutoff_date = excluded.cutoff_date, hed = excluded.hed, hen = excluded.hen,
      hon = excluded.hon, dom = excluded.dom, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(orgId, emp.id, cutoff, hed, hen, hon, dom, note, req.user.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'payroll.opening_balance_set', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, corte: cutoff, extraDiurna: hed, extraNocturna: hen, recargoNocturno: hon, dominical: dom, nota: note } });
  sendJson(res, 200, { ok: true, balances: listOpeningBalances(orgId) });
}

// POST /api/payroll/opening-balance/:employeeId/delete { reason }
async function deleteOpeningBalance(req, res, params) {
  let body;
  try { body = await readBody(req); } catch { body = {}; }
  const orgId = req.user.organizationId;
  const empId = Number(params.employeeId);
  const prev = db.prepare('SELECT * FROM employee_opening_balances WHERE organization_id = ? AND employee_id = ?').get(orgId, empId);
  if (!prev) return sendJson(res, 404, { error: 'Ese colaborador no tiene saldo inicial.' });
  const locks = openingBalanceLock(orgId, prev.cutoff_date);
  if (locks.length) return sendJson(res, 409, { error: `El saldo inicial ya se aplico en el cierre de ${locks[0].closure_type} del ${locks[0].period_start} al ${locks[0].period_end}. Para eliminarlo, reabre ese periodo.` });
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo (minimo 5 caracteres).' });
  db.prepare('DELETE FROM employee_opening_balances WHERE organization_id = ? AND employee_id = ?').run(orgId, empId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'payroll.opening_balance_deleted', resourceType: 'employee', resourceId: String(empId), ip: getClientIp(req),
    metadata: { anterior: { corte: prev.cutoff_date, extraDiurna: prev.hed, extraNocturna: prev.hen, recargoNocturno: prev.hon, dominical: prev.dom, nota: prev.note }, motivo: reason } });
  sendJson(res, 200, { ok: true, balances: listOpeningBalances(orgId) });
}

// GET /api/payroll/closures?from=&to=
function listPayrollClosures(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  if (!ISO_DATE.test(query.from || '') || !ISO_DATE.test(query.to || '')) return sendJson(res, 400, { error: 'Periodo invalido.' });
  const overlapping = db.prepare(`${CLOSURE_SELECT}
    WHERE c.organization_id = ? AND c.period_start <= ? AND c.period_end >= ?
    ORDER BY c.closed_at DESC`).all(orgId, query.to, query.from).map(closureView);
  const prev = previousExtrasClosure(orgId, query.from);
  const lastRec = lastRecargosClosure(orgId);
  sendJson(res, 200, {
    closures: overlapping,
    previousExtras: prev ? closureView(prev) : null,
    recargos: {
      nextStart: nextRecargosStart(orgId),
      maxEnd: addDaysISO(bogotaToday(), -1),
      last: lastRec ? { id: lastRec.id, from: lastRec.period_start, to: lastRec.period_end, closedAt: lastRec.closed_at, closedBy: lastRec.closed_by_email } : null,
    },
  });
}

// POST /api/payroll/closures  { type, from, to, snapshot, pendingDays, previousClosureId }
async function createPayrollClosure(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const { type, from, to } = body;
  if (!CLOSURE_TYPES.includes(type)) return sendJson(res, 400, { error: 'Tipo de cierre invalido.' });
  // Nada anterior o igual al Dia 0 se cierra con marcaciones: eso ya es saldo inicial.
  const dz0 = getDayZero(orgId);
  if (dz0 && from <= dz0) return sendJson(res, 400, { error: `El periodo debe iniciar despues del Dia 0 (${dz0}). Lo anterior se maneja como saldo inicial.` });
  if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '') || from > to) return sendJson(res, 400, { error: 'Periodo invalido.' });
  const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
  if (!snapshot || !Array.isArray(snapshot.employees)) return sendJson(res, 400, { error: 'Faltan los valores del cierre.' });
  // Recargos: el periodo debe continuar exactamente donde termino el anterior
  // (o desde la primera marcacion) y cerrar a mas tardar ayer.
  if (type === 'recargos') {
    const expected = nextRecargosStart(orgId);
    if (!expected) return sendJson(res, 400, { error: 'Aun no hay marcaciones registradas en la organizacion.' });
    if (from !== expected) return sendJson(res, 409, { error: `El periodo de recargos debe iniciar el ${expected} (dia siguiente al ultimo cierre).` });
    if (to > addDaysISO(bogotaToday(), -1)) return sendJson(res, 400, { error: 'La fecha de corte de recargos debe ser como maximo el dia de ayer.' });
  }
  // No se permiten dos cierres activos del mismo tipo que se crucen en fechas.
  const clash = db.prepare(`SELECT period_start, period_end FROM payroll_closures
    WHERE organization_id = ? AND closure_type = ? AND status = 'cerrado' AND period_start <= ? AND period_end >= ?`).get(orgId, type, to, from);
  if (clash) return sendJson(res, 409, { error: `Ya existe un cierre de ${type} del ${clash.period_start} al ${clash.period_end} que se cruza con este periodo.` });
  // Extras: el periodo anterior debe ser el ultimo cierre de extras (para el saldo trasladado).
  let previousId = null;
  if (type === 'extras') {
    const later = db.prepare(`SELECT 1 FROM payroll_closures WHERE organization_id = ? AND closure_type = 'extras' AND status = 'cerrado' AND period_start > ?`).get(orgId, to);
    if (later) return sendJson(res, 409, { error: 'Ya hay un cierre de extras posterior a este periodo. Los cierres de extras deben hacerse en orden.' });
    const prev = previousExtrasClosure(orgId, from);
    previousId = prev ? prev.id : null;
    if ((body.previousClosureId || null) !== previousId) {
      return sendJson(res, 409, { error: 'El saldo anterior cambio mientras revisabas. Vuelve a cargar la liquidacion e intenta de nuevo.' });
    }
  }
  const id = uid('clos');
  db.prepare(`INSERT INTO payroll_closures (id, organization_id, closure_type, period_start, period_end, status, snapshot_json, pending_days, previous_closure_id, closed_by, closed_at)
              VALUES (?, ?, ?, ?, ?, 'cerrado', ?, ?, ?, ?, datetime('now', '-5 hours'))`)
    .run(id, orgId, type, from, to, JSON.stringify(snapshot).slice(0, 2_000_000), Number(body.pendingDays) || 0, previousId, req.user.id);
  logAction({
    organizationId: orgId, userId: req.user.id, action: 'payroll.period_closed', resourceType: 'payroll_closure', resourceId: id, ip: getClientIp(req),
    metadata: { tipo: type, periodo: `${from} al ${to}`, colaboradores: snapshot.employees.length, total: snapshot.totals ? snapshot.totals.pay : null, diasPendientes: Number(body.pendingDays) || 0 },
  });
  sendJson(res, 201, { ok: true, id });
}

// POST /api/payroll/closures/:id/reopen  { reason }
async function reopenPayrollClosure(req, res, params) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = req.user.organizationId;
  const c = db.prepare('SELECT * FROM payroll_closures WHERE id = ? AND organization_id = ?').get(params.id, orgId);
  if (!c) return sendJson(res, 404, { error: 'Cierre no encontrado.' });
  if (c.status !== 'cerrado') return sendJson(res, 400, { error: 'Este periodo ya esta reabierto.' });
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo de la reapertura (minimo 5 caracteres).' });
  if (c.closure_type === 'extras') {
    const later = db.prepare(`SELECT period_start, period_end FROM payroll_closures WHERE organization_id = ? AND closure_type = 'extras' AND status = 'cerrado' AND period_start > ?`).get(orgId, c.period_end);
    if (later) return sendJson(res, 409, { error: `Primero reabre el cierre de extras posterior (${later.period_start} al ${later.period_end}), porque usa el saldo de este periodo.` });
  } else {
    // Recargos: los periodos son continuos; solo se puede reabrir el ULTIMO.
    const later = db.prepare(`SELECT period_start, period_end FROM payroll_closures WHERE organization_id = ? AND closure_type = 'recargos' AND status = 'cerrado' AND period_start > ?`).get(orgId, c.period_end);
    if (later) return sendJson(res, 409, { error: `Primero reabre el cierre de recargos posterior (${later.period_start} al ${later.period_end}). Los periodos de recargos son continuos.` });
  }
  db.prepare(`UPDATE payroll_closures SET status = 'reabierto', reopened_by = ?, reopened_at = datetime('now', '-5 hours'), reopen_reason = ? WHERE id = ?`).run(req.user.id, reason, c.id);
  logAction({
    organizationId: orgId, userId: req.user.id, action: 'payroll.period_reopened', resourceType: 'payroll_closure', resourceId: c.id, ip: getClientIp(req),
    metadata: { tipo: c.closure_type, periodo: `${c.period_start} al ${c.period_end}`, motivo: reason },
  });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// PUBLICAR CUADRO DE TURNOS
// POST /api/shifts/publish { from, to, notify }
// ---------------------------------------------------------------------------
async function publishShifts(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const { from, to } = body;
  if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '') || from > to) return sendJson(res, 400, { error: 'Rango de fechas invalido.' });
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > 62) return sendJson(res, 400, { error: 'Se pueden publicar maximo 62 dias a la vez.' });
  const notify = body.notify !== false;
  const id = uid('pub');
  db.prepare('INSERT INTO shift_publications (id, organization_id, date_from, date_to, notified, published_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, from, to, notify ? 1 : 0, req.user.id);

  // Horario de cada colaborador en el rango publicado.
  const shifts = db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId)
    .map(r => { try { return JSON.parse(r.data_json); } catch { return null; } })
    .filter(sh => sh && sh.date >= from && sh.date <= to);
  const dates = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) dates.push(d);
  let sent = 0, withoutEmail = 0;
  if (notify) {
    const emps = db.prepare('SELECT id, name FROM employees WHERE organization_id = ?').all(orgId);
    for (const emp of emps) {
      const mine = new Map(shifts.filter(sh => Number(sh.empId) === Number(emp.id)).map(sh => [sh.date, sh]));
      if (!mine.size) continue; // sin turnos en el rango: no se notifica
      const email = employeeEmail(orgId, emp.id);
      if (!email) { withoutEmail++; continue; }
      const lines = dates.map(d => `${dayLabel(d)}: ${shiftSummary(mine.get(d))}`);
      sendMail({
        to: email, kind: 'shift_publication', link: '/app.html',
        subject: `Tu horario del ${from.split('-').reverse().join('/')} al ${to.split('-').reverse().join('/')} ya está publicado`,
        bodyText: `Hola ${emp.name}. Este es tu horario:\n\n${lines.join('\n')}\n\nTambién lo puedes ver en la suite, en "Mi horario y marcaciones".`,
        bodyHtml: `<p>Hola ${escHtml(emp.name)}. Este es tu horario:</p><table cellpadding="4" style="border-collapse:collapse">${dates.map(d => `<tr><td style="border-bottom:1px solid #e2e8f0"><strong>${escHtml(dayLabel(d))}</strong></td><td style="border-bottom:1px solid #e2e8f0">${escHtml(shiftSummary(mine.get(d)))}</td></tr>`).join('')}</table><p>También lo puedes ver en la suite, en "Mi horario y marcaciones".</p>`,
      }).catch(() => {});
      sent++;
    }
  }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'shifts.published', resourceType: 'shift_publication', resourceId: id, ip: getClientIp(req),
    metadata: { desde: from, hasta: to, notificados: sent, sinCorreo: withoutEmail } });
  sendJson(res, 201, { ok: true, id, notified: sent, withoutEmail, publications: getPublications(orgId) });
}

// GET /api/shifts/changes?from=&to=  (cambios en turnos ya publicados)
function listShiftChanges(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  if (!ISO_DATE.test(query.from || '') || !ISO_DATE.test(query.to || '')) return sendJson(res, 400, { error: 'Periodo invalido.' });
  const rows = db.prepare(`
    SELECT c.employee_id AS employeeId, e.name AS employeeName, c.shift_date AS date, c.before_text AS before, c.after_text AS after,
           c.changed_at AS changedAt, c.notified, u.email AS changedBy
    FROM shift_changes c LEFT JOIN employees e ON e.id = c.employee_id LEFT JOIN users u ON u.id = c.changed_by
    WHERE c.organization_id = ? AND c.shift_date BETWEEN ? AND ?
    ORDER BY c.changed_at DESC LIMIT 500`).all(orgId, query.from, query.to);
  sendJson(res, 200, { rows });
}

// PUT /api/org/rotation-patterns { patterns: [...] }
async function replaceRotationPatterns(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const list = Array.isArray(body.patterns) ? body.patterns.slice(0, 50) : [];
  db.prepare('DELETE FROM rotation_patterns WHERE organization_id = ?').run(orgId);
  const ins = db.prepare('INSERT INTO rotation_patterns (id, organization_id, data_json) VALUES (?, ?, ?)');
  for (const p of list) {
    if (!p || !Array.isArray(p.days) || !p.days.length || p.days.length > 28) continue;
    ins.run(String(p.id || uid('rot')), orgId, JSON.stringify({ id: String(p.id || ''), name: String(p.name || 'Rotación').slice(0, 60), days: p.days.map(d => String(d || 'descanso').slice(0, 80)) }));
  }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'rotation_patterns.replace', ip: getClientIp(req), metadata: { count: list.length } });
  sendJson(res, 200, { ok: true });
}

// ===========================================================================
// RETIRO DE COLABORADORES (en lugar de borrarlos)
// ===========================================================================
const RETIRE_REASONS = ['Renuncia voluntaria', 'Terminación con justa causa', 'Terminación sin justa causa', 'Vencimiento del contrato',
  'Mutuo acuerdo', 'Terminación en periodo de prueba', 'Pensión', 'Fallecimiento', 'Otro'];
function bogotaToday() { return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10); }

// ¿El colaborador tiene historial que la empresa debe conservar?
function employeeHasHistory(orgId, empId) {
  const id = Number(empId);
  const q = (sql, ...a) => !!db.prepare(sql).get(...a);
  if (q('SELECT 1 FROM attendance_marks WHERE employee_id = ? LIMIT 1', id)) return true;
  if (q('SELECT 1 FROM attendance_days WHERE employee_id = ? LIMIT 1', id)) return true;
  if (q('SELECT 1 FROM attendance_alerts WHERE employee_id = ? LIMIT 1', id)) return true;
  try { if (q('SELECT 1 FROM attendance_corrections WHERE employee_id = ? LIMIT 1', id)) return true; } catch { /* tabla ausente */ }
  try { if (q('SELECT 1 FROM employee_opening_balances WHERE employee_id = ? LIMIT 1', id)) return true; } catch { /* tabla ausente */ }
  const pats = [`%"employeeId":${id},%`, `%"employeeId":${id}}%`, `%"employeeId":"${id}"%`];
  if (q('SELECT 1 FROM payroll_closures WHERE organization_id = ? AND (snapshot_json LIKE ? OR snapshot_json LIKE ? OR snapshot_json LIKE ?) LIMIT 1', orgId, ...pats)) return true;
  return false;
}

function deleteShiftsOfEmployee(orgId, empId, afterDate) {
  const del = db.prepare('DELETE FROM shifts WHERE id = ?');
  let n = 0;
  for (const r of db.prepare('SELECT id, data_json FROM shifts WHERE organization_id = ?').all(orgId)) {
    try {
      const sh = JSON.parse(r.data_json);
      if (Number(sh.empId) === Number(empId) && (!afterDate || sh.date > afterDate)) { del.run(r.id); n++; }
    } catch { /* fila invalida */ }
  }
  return n;
}

function deleteEmployeeCompletely(orgId, empId) {
  deleteShiftsOfEmployee(orgId, empId, null);
  db.prepare('UPDATE users SET employee_id = NULL WHERE organization_id = ? AND employee_id = ?').run(orgId, Number(empId));
  db.prepare('DELETE FROM employees WHERE organization_id = ? AND id = ?').run(orgId, Number(empId));
}

function retireEmployeeRecord(orgId, empId, { date, reason, detail, userId, deactivateUser, ip, auto }) {
  const emp = db.prepare('SELECT id, name FROM employees WHERE id = ? AND organization_id = ?').get(Number(empId), orgId);
  if (!emp) return null;
  db.prepare("UPDATE employees SET status = 'retirado', retired_at = ?, retire_reason = ?, retire_detail = ?, retired_by = ? WHERE id = ?")
    .run(date, reason, detail || null, userId || null, emp.id);
  const shiftsRemoved = deleteShiftsOfEmployee(orgId, emp.id, date);   // turnos posteriores al retiro
  db.prepare('DELETE FROM attendance_device_employees WHERE employee_id = ?').run(emp.id); // ya no marca en ningún kiosco
  const faceRemoved = db.prepare('DELETE FROM employee_face_profiles WHERE employee_id = ?').run(emp.id).changes; // Ley 1581: sin biometría
  let userDeactivated = null;
  if (deactivateUser) {
    const u = db.prepare("SELECT id, email FROM users WHERE organization_id = ? AND employee_id = ? AND status != 'inactive'").get(orgId, emp.id);
    if (u) { db.prepare("UPDATE users SET status = 'inactive', updated_at = datetime('now') WHERE id = ?").run(u.id); userDeactivated = u.email; }
  }
  logAction({ organizationId: orgId, userId, action: 'employee.retired', resourceType: 'employee', resourceId: String(emp.id), ip,
    metadata: { colaborador: emp.name, fecha: date, motivo: reason, detalle: detail || null, turnosQuitados: shiftsRemoved, perfilFacialBorrado: faceRemoved > 0, usuarioDesactivado: userDeactivated, automatico: !!auto } });
  return { shiftsRemoved, faceRemoved: faceRemoved > 0, userDeactivated };
}

// POST /api/employees/:id/retire  { date, reason, detail, deactivateUser }
async function retireEmployee(req, res, params) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(Number(params.id), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  if (emp.status === 'retirado') return sendJson(res, 409, { error: 'Este colaborador ya está retirado.' });
  const date = String(body.date || '');
  if (!ISO_DATE.test(date)) return sendJson(res, 400, { error: 'Indica la fecha de retiro (último día laborado).' });
  const reason = RETIRE_REASONS.includes(body.reason) ? body.reason : null;
  if (!reason) return sendJson(res, 400, { error: 'Elige el motivo del retiro.' });
  const detail = String(body.detail || '').trim().slice(0, 300);
  if (reason === 'Otro' && detail.length < 5) return sendJson(res, 400, { error: 'Describe el motivo del retiro (mínimo 5 caracteres).' });
  // No puede haber marcaciones después del último día laborado.
  const lastMark = db.prepare('SELECT MAX(shift_date) AS d FROM attendance_marks WHERE employee_id = ?').get(emp.id).d;
  if (lastMark && lastMark > date) return sendJson(res, 409, { error: `Tiene marcaciones hasta el ${lastMark.split('-').reverse().join('/')}. La fecha de retiro no puede ser anterior.` });
  const r = retireEmployeeRecord(orgId, emp.id, { date, reason, detail, userId: req.user.id, deactivateUser: !!body.deactivateUser, ip: getClientIp(req) });
  sendJson(res, 200, { ok: true, ...r, retiredAt: date, dataVersion: bumpDataVersion(orgId) });
}

// POST /api/employees/:id/reactivate
async function reactivateEmployee(req, res, params) {
  let body = {};
  try { body = await readBody(req); } catch { /* opcional */ }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare("SELECT * FROM employees WHERE id = ? AND organization_id = ? AND status = 'retirado'").get(Number(params.id), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador retirado no encontrado.' });
  db.prepare("UPDATE employees SET status = 'activo', retired_at = NULL, retire_reason = NULL, retire_detail = NULL, retired_by = NULL WHERE id = ?").run(emp.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'employee.reactivated', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, retiroAnterior: emp.retired_at, motivoAnterior: emp.retire_reason } });
  sendJson(res, 200, { ok: true, dataVersion: bumpDataVersion(orgId) });
}

// POST /api/employees/:id/delete-permanent -- solo fichas SIN historial (ej. creadas por error).
async function deleteEmployeePermanent(req, res, params) {
  let body = {};
  try { body = await readBody(req); } catch { /* opcional */ }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(Number(params.id), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  if (employeeHasHistory(orgId, emp.id)) return sendJson(res, 409, { error: 'Este colaborador tiene marcaciones o liquidaciones registradas: no se puede eliminar, solo retirar. Su historial debe conservarse.' });
  deleteEmployeeCompletely(orgId, emp.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'employee.deleted', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req), metadata: { colaborador: emp.name, sinHistorial: true } });
  sendJson(res, 200, { ok: true, dataVersion: bumpDataVersion(orgId) });
}

// GET /api/employees/:id/has-history
function employeeHistoryCheck(req, res, params, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND organization_id = ?').get(Number(params.id), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  sendJson(res, 200, { hasHistory: employeeHasHistory(orgId, emp.id) });
}

module.exports = {
  getShiftsRange, saveDataRetention,
  retireEmployee, reactivateEmployee, deleteEmployeePermanent, employeeHistoryCheck,
  setDayZero, saveOpeningBalance, deleteOpeningBalance,
  publishShifts, listShiftChanges, replaceRotationPatterns,
  listPayrollClosures, createPayrollClosure, reopenPayrollClosure,
  listPayrollAdjustments, savePayrollAdjustment, resetPayrollAdjustments,
  getOrgData, seedDemo, updateSettings, replaceDepartments, replaceShiftPresets, syncEmployeesAndShifts,
  listOrgUsers, createOrgUser, updateOrgUser, toggleOrgUserStatus, resetOrgUserPassword, listOrgAudit,
  resolveOrgId,
};
