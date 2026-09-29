'use strict';
// Modulo de ASISTENCIA — archivo NUEVO Y AISLADO. No importa ni modifica
// ninguna logica de los demas modulos (empleados, turnos, liquidacion,
// usuarios). Solo LEE datos existentes de `employees` y `shifts` (nunca los
// modifica) para poder determinar automaticamente el turno del dia.
const { db, uid } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { randomToken, sha256Hex } = require('../lib/crypto');
const rules = require('../lib/attendance-rules');
const bogota = require('../lib/bogota-time');

function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}

// Busca, dentro de los turnos ya guardados por el modulo de Cuadro de
// Turnos (tabla `shifts`, sin modificarla), el turno de un empleado en una
// fecha especifica. Solo LECTURA.
function getShiftForEmployeeDate(orgId, employeeId, dateISO) {
  const rows = db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId);
  for (const row of rows) {
    let s;
    try { s = JSON.parse(row.data_json); } catch { continue; }
    if (Number(s.empId) === Number(employeeId) && s.date === dateISO) return s;
  }
  return null;
}

function isOvernightShift(shift) {
  if (!shift || shift.isOffDay) return false;
  const start = rules.timeToMinutes(shift.startTime);
  const end = rules.timeToMinutes(shift.endTime);
  if (start == null || end == null) return false;
  return end <= start;
}

// Determina a que shift_date pertenece una marca que llega AHORA MISMO.
// Si ayer quedo un turno nocturno abierto (con entrada marcada pero sin
// salida), las marcas de la madrugada de hoy le pertenecen a ESE turno de
// ayer, no a uno nuevo de hoy (Regla 26).
function resolveShiftDateForMark(orgId, employeeId, now) {
  const todayISO = bogota.todayISOInBogota(now);
  const yesterdayISO = bogota.addDaysISO(todayISO, -1);
  const openYesterday = db.prepare(
    "SELECT * FROM attendance_days WHERE organization_id = ? AND employee_id = ? AND shift_date = ? AND status != 'turno_finalizado'"
  ).get(orgId, employeeId, yesterdayISO);
  if (openYesterday) {
    const shiftY = getShiftForEmployeeDate(orgId, employeeId, yesterdayISO);
    if (shiftY && isOvernightShift(shiftY)) return yesterdayISO;
  }
  return todayISO;
}

function getExistingMarkTypes(employeeId, shiftDateISO) {
  return db.prepare(
    'SELECT mark_type FROM attendance_marks WHERE employee_id = ? AND shift_date = ? ORDER BY created_at ASC'
  ).all(employeeId, shiftDateISO).map(r => r.mark_type);
}

function upsertAttendanceDay(orgId, employeeId, shiftDateISO, shift, patch) {
  const existing = db.prepare(
    'SELECT * FROM attendance_days WHERE employee_id = ? AND shift_date = ?'
  ).get(employeeId, shiftDateISO);
  if (!existing) {
    db.prepare(`
      INSERT INTO attendance_days (id, organization_id, employee_id, shift_date, status,
        scheduled_entrada, scheduled_inicio_almuerzo, scheduled_fin_almuerzo, scheduled_salida)
      VALUES (?, ?, ?, ?, 'pendiente_entrada', ?, NULL, NULL, ?)
    `).run(uid('atd'), orgId, employeeId, shiftDateISO, shift ? shift.startTime : null, shift ? shift.endTime : null);
  }
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const setSql = fields.map(f => `${f} = ?`).join(', ') + ", updated_at = datetime('now')";
  const values = fields.map(f => patch[f]);
  db.prepare(`UPDATE attendance_days SET ${setSql} WHERE employee_id = ? AND shift_date = ?`)
    .run(...values, employeeId, shiftDateISO);
}

function insertAlert(orgId, employeeId, shiftDateISO, alertType, scheduledTime, actualTime, diffMinutes, metadata) {
  db.prepare(`
    INSERT INTO attendance_alerts (id, organization_id, employee_id, shift_date, alert_type, scheduled_time, actual_time, diff_minutes, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid('alert'), orgId, employeeId, shiftDateISO, alertType, scheduledTime || null, actualTime || null, diffMinutes == null ? null : Math.round(diffMinutes), JSON.stringify(metadata || {}));
}

function hhmmFromAbsMinutes(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const h = p.find(x => x.type === 'hour').value;
  const m = p.find(x => x.type === 'minute').value;
  return `${h}:${m}`;
}

// ---------------------------------------------------------------------------
// GET /api/attendance/employees-today
// Lista los colaboradores de la organizacion con su turno de hoy y cual es
// la siguiente marcacion esperada (el operador del punto de marcacion NUNCA
// elige el tipo de marcacion, solo identifica al empleado -- Regla 13).
// ---------------------------------------------------------------------------
function listEmployeesToday(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const now = new Date();
  const employees = db.prepare('SELECT id, name, role, department FROM employees WHERE organization_id = ? ORDER BY name ASC').all(orgId);

  const result = employees.map(emp => {
    const shiftDateISO = resolveShiftDateForMark(orgId, emp.id, now);
    const shift = getShiftForEmployeeDate(orgId, emp.id, shiftDateISO);
    if (!shift || shift.isOffDay) {
      return { id: emp.id, name: emp.name, role: emp.role, hasShift: false, nextMark: null, shift: null };
    }
    const marksDone = getExistingMarkTypes(emp.id, shiftDateISO);
    const nextMark = rules.nextExpectedMarkType(marksDone);
    return {
      id: emp.id,
      name: emp.name,
      role: emp.role,
      hasShift: true,
      shift: { date: shiftDateISO, startTime: shift.startTime, endTime: shift.endTime },
      nextMark,
      completed: nextMark === null,
    };
  });
  sendJson(res, 200, { employees: result });
}

// ---------------------------------------------------------------------------
// Nucleo de "registrar una marcacion" (sin nada de HTTP). Lo usan tanto la
// marcacion manual (registerMark) como la marcacion por reconocimiento
// facial (registerMarkByFace) -- misma logica de negocio, una sola vez.
// Devuelve { httpStatus, body } (nunca lanza para errores esperados de
// negocio, solo para errores de programacion reales).
// ---------------------------------------------------------------------------
function performMark(orgId, employeeId, userId, method, ip) {
  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(employeeId, orgId);
  // Aislamiento multi-organizacion (Caso 12 del documento): si el empleado no
  // pertenece a esta organizacion, se responde como "no encontrado", igual
  // que el resto de la app hace con otros recursos entre organizaciones.
  if (!employee) return { httpStatus: 404, body: { error: 'Colaborador no encontrado en esta organizacion.' } };

  const now = new Date();
  const shiftDateISO = resolveShiftDateForMark(orgId, employeeId, now);
  const shift = getShiftForEmployeeDate(orgId, employeeId, shiftDateISO);
  if (!shift || shift.isOffDay) {
    return { httpStatus: 409, body: { error: 'Este colaborador no tiene un turno asignado para hoy.', state: 'sin_turno' } };
  }

  const marksDone = getExistingMarkTypes(employeeId, shiftDateISO);
  const seq = rules.validateMarkSequence(marksDone, null);
  const markType = seq.expected;
  if (markType == null) {
    return { httpStatus: 409, body: { error: 'El turno de hoy ya tiene las 4 marcaciones completas.', state: 'completo' } };
  }

  const actualAbsMin = bogota.minutesSinceShiftMidnight(now, shiftDateISO);
  const actualClock = hhmmFromAbsMinutes(now);
  const nowIso = now.toISOString();

  let alert = null;
  let statusLabel = null;
  const patch = {};

  if (markType === 'entrada') {
    const scheduledAbsMin = rules.scheduledAbsoluteMinutes(shift.startTime, shift.startTime); // siempre 0 (es la referencia)
    const cls = rules.classifyEntrada(scheduledAbsMin, actualAbsMin);
    patch.entrada_real = actualClock;
    patch.retraso_min = cls.status === 'tarde' ? cls.diffMinutes : 0;
    patch.status = cls.status === 'tarde' ? 'llegada_tarde' : 'llegada_anticipada';
    statusLabel = patch.status;
    if (cls.status === 'tarde') {
      insertAlert(orgId, employeeId, shiftDateISO, 'llegada_tarde', shift.startTime, actualClock, cls.diffMinutes, { employeeName: employee.name });
      alert = { type: 'llegada_tarde', diffMinutes: cls.diffMinutes };
    }
  }

  if (markType === 'inicio_almuerzo') {
    patch.inicio_almuerzo_real = actualClock;
    patch.status = 'en_almuerzo';
    statusLabel = 'en_almuerzo';
  }

  if (markType === 'fin_almuerzo') {
    const dayRow = db.prepare('SELECT * FROM attendance_days WHERE employee_id = ? AND shift_date = ?').get(employeeId, shiftDateISO);
    const inicioAlmMin = dayRow && dayRow.inicio_almuerzo_real ? rules.timeToMinutes(dayRow.inicio_almuerzo_real) : null;
    const actualClockMin = rules.timeToMinutes(actualClock);
    let actualBreakMinutes = 0;
    if (inicioAlmMin != null && actualClockMin != null) {
      actualBreakMinutes = actualClockMin >= inicioAlmMin ? (actualClockMin - inicioAlmMin) : (actualClockMin + 1440 - inicioAlmMin);
    }
    const cls = rules.classifyAlmuerzo(Number(shift.breakM) || 0, actualBreakMinutes);
    patch.fin_almuerzo_real = actualClock;
    patch.exceso_almuerzo_min = cls.excessMinutes;
    patch.status = 'en_jornada';
    statusLabel = cls.excessMinutes > 0 ? 'exceso_almuerzo' : 'en_jornada';
    if (cls.excessMinutes > 0) {
      insertAlert(orgId, employeeId, shiftDateISO, 'exceso_almuerzo', null, actualClock, cls.excessMinutes, {
        employeeName: employee.name, permitidoMin: Number(shift.breakM) || 0, usadoMin: actualBreakMinutes,
      });
      alert = { type: 'exceso_almuerzo', diffMinutes: cls.excessMinutes };
    }
  }

  if (markType === 'salida') {
    const scheduledSalidaAbsMin = rules.scheduledAbsoluteMinutes(shift.endTime, shift.startTime);
    const clsSalida = rules.classifySalida(scheduledSalidaAbsMin, actualAbsMin);
    patch.salida_real = actualClock;
    patch.salida_anticipada_min = clsSalida.adeudadoMinutes;
    patch.status = 'turno_finalizado';
    statusLabel = clsSalida.adeudadoMinutes > 0 ? 'salida_anticipada' : 'salida_puntual';
    if (clsSalida.adeudadoMinutes > 0) {
      insertAlert(orgId, employeeId, shiftDateISO, 'salida_anticipada', shift.endTime, actualClock, clsSalida.adeudadoMinutes, { employeeName: employee.name });
      alert = { type: 'salida_anticipada', diffMinutes: clsSalida.adeudadoMinutes };
    }

    // Categorizacion de horas (Regla 14) usando las marcas reales del dia.
    const dayRow = db.prepare('SELECT * FROM attendance_days WHERE employee_id = ? AND shift_date = ?').get(employeeId, shiftDateISO);
    const entradaClock = dayRow ? dayRow.entrada_real : shift.startTime;
    const entradaAbsMin = rules.scheduledAbsoluteMinutes(entradaClock, shift.startTime);
    let breakActualMinutes = Number(shift.breakM) || 0;
    if (dayRow && dayRow.inicio_almuerzo_real && dayRow.fin_almuerzo_real) {
      const a = rules.timeToMinutes(dayRow.inicio_almuerzo_real);
      const b = rules.timeToMinutes(dayRow.fin_almuerzo_real);
      if (a != null && b != null) breakActualMinutes = b >= a ? (b - a) : (b + 1440 - a);
    }
    const cat = rules.categorizeWorkedMinutes({
      scheduledEntradaMin: rules.timeToMinutes(shift.startTime),
      scheduledSalidaMin: scheduledSalidaAbsMin,
      actualEntradaMin: entradaAbsMin == null ? 0 : entradaAbsMin,
      actualSalidaMin: actualAbsMin,
      breakMinutes: breakActualMinutes,
    });
    const hedFinal = rules.applyEarlyLeaveDeduction(cat.hed, clsSalida.adeudadoMinutes);
    patch.hod_min = cat.hod;
    patch.hon_min = cat.hon;
    patch.hed_min = hedFinal;
    patch.hen_min = cat.hen;
    if (hedFinal > 0 || cat.hen > 0) {
      insertAlert(orgId, employeeId, shiftDateISO, 'hora_extra', shift.endTime, actualClock, hedFinal + cat.hen, {
        employeeName: employee.name, hedMin: hedFinal, henMin: cat.hen,
      });
    }
  }

  db.prepare(`
    INSERT INTO attendance_marks (id, organization_id, employee_id, shift_date, mark_type, scheduled_time, actual_at, method, marked_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid('mark'), orgId, employeeId, shiftDateISO, markType, shift.startTime || null, nowIso, method, userId);

  upsertAttendanceDay(orgId, employeeId, shiftDateISO, shift, patch);

  logAction({ organizationId: orgId, userId, action: 'attendance.mark', resourceType: 'employee', resourceId: String(employeeId), ip, metadata: { markType, shiftDateISO, actualClock, method } });

  return {
    httpStatus: 200,
    body: {
      ok: true,
      employeeName: employee.name,
      markType,
      actualTime: actualClock,
      shift: { startTime: shift.startTime, endTime: shift.endTime },
      status: statusLabel,
      alert,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/attendance/mark
// Body: { employeeId }. El servidor determina TODO lo demas automaticamente:
// organizacion (de la sesion), fecha/turno, y tipo de marcacion.
// ---------------------------------------------------------------------------
async function registerMark(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });

  const employeeId = Number(body.employeeId);
  const result = performMark(orgId, employeeId, req.user.id, 'manual', getClientIp(req));
  sendJson(res, result.httpStatus, result.body);
}

// ---------------------------------------------------------------------------
// GET /api/attendance/history?from=YYYY-MM-DD&to=YYYY-MM-DD
// ---------------------------------------------------------------------------
function listHistory(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const from = query.from || bogota.todayISOInBogota();
  const to = query.to || from;
  const rows = db.prepare(`
    SELECT d.*, e.name as employee_name
    FROM attendance_days d
    JOIN employees e ON e.id = d.employee_id
    WHERE d.organization_id = ? AND d.shift_date BETWEEN ? AND ?
    ORDER BY d.shift_date DESC, e.name ASC
  `).all(orgId, from, to);
  sendJson(res, 200, { rows });
}

// ---------------------------------------------------------------------------
// GET /api/attendance/alerts?from=YYYY-MM-DD&to=YYYY-MM-DD
// ---------------------------------------------------------------------------
function listAlerts(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const from = query.from || bogota.addDaysISO(bogota.todayISOInBogota(), -7);
  const to = query.to || bogota.todayISOInBogota();
  const rows = db.prepare(`
    SELECT a.*, e.name as employee_name
    FROM attendance_alerts a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.organization_id = ? AND a.shift_date BETWEEN ? AND ?
    ORDER BY a.created_at DESC
  `).all(orgId, from, to);
  sendJson(res, 200, { rows });
}

// ---------------------------------------------------------------------------
// RECONOCIMIENTO FACIAL (Fase 2)
// Solo se guarda la "plantilla" matematica del rostro (un vector de 128
// numeros que produce face-api.js), NUNCA la fotografia -- Regla 20 del
// documento. La comparacion (distancia euclidiana) se hace aqui, en el
// servidor, sobre los perfiles de la MISMA organizacion unicamente.
// ---------------------------------------------------------------------------
const FACE_MATCH_THRESHOLD = 0.5; // distancia euclidiana maxima para aceptar una coincidencia (mientras mas bajo, mas estricto)
const FACE_CONSENT_TEXT = 'El colaborador autoriza expresamente el uso de su rostro (dato biometrico) para fines de control de asistencia laboral, conforme a la Ley 1581 de 2012 de proteccion de datos personales (Habeas Data).';

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function validDescriptor(d) {
  return Array.isArray(d) && d.length === 128 && d.every(n => typeof n === 'number' && Number.isFinite(n));
}

// ---------------------------------------------------------------------------
// GET /api/attendance/face-profiles
// ---------------------------------------------------------------------------
function listFaceProfiles(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const employees = db.prepare('SELECT id, name, role FROM employees WHERE organization_id = ? ORDER BY name ASC').all(orgId);
  const profiles = db.prepare('SELECT employee_id, active, consent_given, consent_at, updated_at FROM employee_face_profiles WHERE organization_id = ?').all(orgId);
  const byEmp = Object.fromEntries(profiles.map(p => [p.employee_id, p]));
  sendJson(res, 200, {
    employees: employees.map(e => ({
      id: e.id, name: e.name, role: e.role,
      profile: byEmp[e.id] ? { active: !!byEmp[e.id].active, consentGiven: !!byEmp[e.id].consent_given, updatedAt: byEmp[e.id].updated_at } : null,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/attendance/face-profiles
// Body: { employeeId, descriptor: number[128], consent: true }
// ---------------------------------------------------------------------------
async function enrollFaceProfile(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });

  const employeeId = Number(body.employeeId);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(employeeId, orgId);
  if (!employee) return sendJson(res, 404, { error: 'Colaborador no encontrado en esta organizacion.' });

  if (!body.consent) {
    return sendJson(res, 400, { error: 'Se requiere el consentimiento explicito del colaborador para registrar su rostro (dato biometrico).' });
  }
  if (!validDescriptor(body.descriptor)) {
    return sendJson(res, 400, { error: 'La plantilla facial recibida no es valida.' });
  }

  const existing = db.prepare('SELECT id FROM employee_face_profiles WHERE employee_id = ?').get(employeeId);
  const nowIso = new Date().toISOString();
  if (existing) {
    db.prepare(`
      UPDATE employee_face_profiles
      SET descriptor_json = ?, enrolled_by_user_id = ?, consent_given = 1, consent_at = ?, consent_text = ?, active = 1, updated_at = datetime('now')
      WHERE employee_id = ?
    `).run(JSON.stringify(body.descriptor), req.user.id, nowIso, FACE_CONSENT_TEXT, employeeId);
  } else {
    db.prepare(`
      INSERT INTO employee_face_profiles (id, organization_id, employee_id, descriptor_json, enrolled_by_user_id, consent_given, consent_at, consent_text, active)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)
    `).run(uid('face'), orgId, employeeId, JSON.stringify(body.descriptor), req.user.id, nowIso, FACE_CONSENT_TEXT);
  }

  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.face_enroll', resourceType: 'employee', resourceId: String(employeeId), ip: getClientIp(req), metadata: { employeeName: employee.name } });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/attendance/face-profiles/:id/deactivate
// ---------------------------------------------------------------------------
async function deactivateFaceProfile(req, res, params) {
  let body = {};
  try { body = await readBody(req); } catch { /* body opcional en esta ruta */ }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const employeeId = Number(params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(employeeId, orgId);
  if (!employee) return sendJson(res, 404, { error: 'Colaborador no encontrado en esta organizacion.' });
  db.prepare("UPDATE employee_face_profiles SET active = 0, updated_at = datetime('now') WHERE employee_id = ? AND organization_id = ?").run(employeeId, orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.face_deactivate', resourceType: 'employee', resourceId: String(employeeId), ip: getClientIp(req), metadata: { employeeName: employee.name } });
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/attendance/mark-by-face
// Body: { descriptor: number[128] }. Identifica al colaborador COMPARANDO
// SOLO contra los perfiles activos de la organizacion de la sesion (nunca
// contra otras organizaciones), y si hay coincidencia, delega en el mismo
// performMark() que usa la marcacion manual.
// ---------------------------------------------------------------------------
async function registerMarkByFace(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  if (!validDescriptor(body.descriptor)) {
    return sendJson(res, 400, { error: 'No se pudo leer el rostro correctamente. Intenta de nuevo.' });
  }

  const profiles = db.prepare(
    'SELECT employee_id, descriptor_json FROM employee_face_profiles WHERE organization_id = ? AND active = 1'
  ).all(orgId);

  let best = null;
  for (const p of profiles) {
    let descriptor;
    try { descriptor = JSON.parse(p.descriptor_json); } catch { continue; }
    const dist = euclideanDistance(body.descriptor, descriptor);
    if (!best || dist < best.dist) best = { employeeId: p.employee_id, dist };
  }

  if (!best || best.dist > FACE_MATCH_THRESHOLD) {
    return sendJson(res, 404, { error: 'Rostro no reconocido. Intenta de nuevo o usa la selección manual.', state: 'no_reconocido' });
  }

  const result = performMark(orgId, best.employeeId, req.user.id, 'facial', getClientIp(req));
  sendJson(res, result.httpStatus, result.body);
}

// ---------------------------------------------------------------------------
// DISPOSITIVOS DE MARCACION (Fase 3)
// Permite restringir DONDE se puede marcar: solo desde tablets/totems
// registrados (con su propio token, sin usuario ni contrasena), y ademas
// QUE colaboradores puede reconocer cada uno (por area/departamento).
// ---------------------------------------------------------------------------

function deviceOutputRow(d) {
  return { id: d.id, name: d.device_name, active: !!d.active, lastUsedAt: d.last_used_at, createdAt: d.created_at };
}

// GET /api/attendance/devices
function listDevices(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const devices = db.prepare('SELECT * FROM attendance_devices WHERE organization_id = ? ORDER BY created_at DESC').all(orgId);
  const counts = Object.fromEntries(
    db.prepare(`SELECT device_id, COUNT(*) as n FROM attendance_device_employees WHERE device_id IN (SELECT id FROM attendance_devices WHERE organization_id = ?) GROUP BY device_id`).all(orgId).map(r => [r.device_id, r.n])
  );
  sendJson(res, 200, { devices: devices.map(d => ({ ...deviceOutputRow(d), assignedCount: counts[d.id] || 0 })) });
}

// POST /api/attendance/devices  Body: { deviceName }
// Devuelve el token EN CRUDO una sola vez (nunca se puede volver a ver).
async function createDevice(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const deviceName = String(body.deviceName || '').trim().slice(0, 120);
  if (!deviceName) return sendJson(res, 400, { error: 'El nombre del dispositivo es obligatorio.' });

  const rawToken = randomToken(32);
  const id = uid('dev');
  db.prepare(`
    INSERT INTO attendance_devices (id, organization_id, device_name, token_hash, created_by_user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, orgId, deviceName, sha256Hex(rawToken), req.user.id);

  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.device_create', resourceType: 'attendance_device', resourceId: id, ip: getClientIp(req), metadata: { deviceName } });
  sendJson(res, 201, { device: { id, name: deviceName, active: true }, token: rawToken });
}

// POST /api/attendance/devices/:id/rotate -- invalida el token anterior y entrega uno nuevo.
async function rotateDeviceToken(req, res, params) {
  let body = {};
  try { body = await readBody(req); } catch { /* opcional */ }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const device = db.prepare('SELECT * FROM attendance_devices WHERE id = ? AND organization_id = ?').get(params.id, orgId);
  if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado en esta organizacion.' });
  const rawToken = randomToken(32);
  db.prepare('UPDATE attendance_devices SET token_hash = ? WHERE id = ?').run(sha256Hex(rawToken), device.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.device_rotate', resourceType: 'attendance_device', resourceId: device.id, ip: getClientIp(req), metadata: { deviceName: device.device_name } });
  sendJson(res, 200, { token: rawToken });
}

// POST /api/attendance/devices/:id/deactivate
async function deactivateDevice(req, res, params) {
  let body = {};
  try { body = await readBody(req); } catch { /* opcional */ }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const device = db.prepare('SELECT * FROM attendance_devices WHERE id = ? AND organization_id = ?').get(params.id, orgId);
  if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado en esta organizacion.' });
  db.prepare('UPDATE attendance_devices SET active = 0 WHERE id = ?').run(device.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.device_deactivate', resourceType: 'attendance_device', resourceId: device.id, ip: getClientIp(req), metadata: { deviceName: device.device_name } });
  sendJson(res, 200, { ok: true });
}

// GET /api/attendance/devices/:id/employees -- lista TODOS los colaboradores
// de la organizacion, marcando cuales ya estan asignados a este dispositivo.
function getDeviceAssignments(req, res, params, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const device = db.prepare('SELECT * FROM attendance_devices WHERE id = ? AND organization_id = ?').get(params.id, orgId);
  if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado en esta organizacion.' });
  const employees = db.prepare('SELECT id, name, department FROM employees WHERE organization_id = ? ORDER BY department ASC, name ASC').all(orgId);
  const assigned = new Set(db.prepare('SELECT employee_id FROM attendance_device_employees WHERE device_id = ?').all(device.id).map(r => r.employee_id));
  sendJson(res, 200, {
    device: deviceOutputRow(device),
    employees: employees.map(e => ({ id: e.id, name: e.name, department: e.department, assigned: assigned.has(e.id) })),
  });
}

// POST /api/attendance/devices/:id/employees  Body: { employeeIds: number[] }
// Reemplaza por completo la lista de colaboradores permitidos en ese dispositivo.
async function setDeviceAssignments(req, res, params) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const device = db.prepare('SELECT * FROM attendance_devices WHERE id = ? AND organization_id = ?').get(params.id, orgId);
  if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado en esta organizacion.' });
  const employeeIds = Array.isArray(body.employeeIds) ? body.employeeIds.map(Number) : [];

  db.prepare('DELETE FROM attendance_device_employees WHERE device_id = ?').run(device.id);
  const insert = db.prepare('INSERT OR IGNORE INTO attendance_device_employees (device_id, employee_id) VALUES (?, ?)');
  for (const empId of employeeIds) {
    const belongs = db.prepare('SELECT id FROM employees WHERE id = ? AND organization_id = ?').get(empId, orgId);
    if (belongs) insert.run(device.id, empId);
  }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.device_assign', resourceType: 'attendance_device', resourceId: device.id, ip: getClientIp(req), metadata: { count: employeeIds.length } });
  sendJson(res, 200, { ok: true, assignedCount: employeeIds.length });
}

// ---------------------------------------------------------------------------
// ENDPOINTS DEL KIOSCO -- autenticados por TOKEN DE DISPOSITIVO, nunca por
// sesion de usuario. Se registran en server.js con { auth: false } (sin
// cookie de sesion ni CSRF), y esta funcion hace su propia verificacion.
// ---------------------------------------------------------------------------
function authenticateDevice(req, res) {
  const token = req.headers['x-device-token'];
  if (!token || typeof token !== 'string') {
    sendJson(res, 401, { error: 'Falta el token del dispositivo.' });
    return null;
  }
  const device = db.prepare('SELECT * FROM attendance_devices WHERE token_hash = ?').get(sha256Hex(token));
  if (!device || !device.active) {
    sendJson(res, 401, { error: 'Dispositivo no autorizado o desactivado.' });
    return null;
  }
  db.prepare("UPDATE attendance_devices SET last_used_at = datetime('now') WHERE id = ?").run(device.id);
  return device;
}

// GET /api/kiosk/employees-today
function kioskEmployeesToday(req, res) {
  const device = authenticateDevice(req, res);
  if (!device) return;
  const orgId = device.organization_id;
  const now = new Date();
  const assignedIds = new Set(db.prepare('SELECT employee_id FROM attendance_device_employees WHERE device_id = ?').all(device.id).map(r => r.employee_id));
  const employees = db.prepare('SELECT id, name FROM employees WHERE organization_id = ? ORDER BY name ASC').all(orgId)
    .filter(e => assignedIds.has(e.id));

  const result = employees.map(emp => {
    const shiftDateISO = resolveShiftDateForMark(orgId, emp.id, now);
    const shift = getShiftForEmployeeDate(orgId, emp.id, shiftDateISO);
    if (!shift || shift.isOffDay) return { id: emp.id, name: emp.name, hasShift: false, nextMark: null };
    const marksDone = getExistingMarkTypes(emp.id, shiftDateISO);
    const nextMark = rules.nextExpectedMarkType(marksDone);
    return { id: emp.id, name: emp.name, hasShift: true, nextMark, completed: nextMark === null };
  });
  sendJson(res, 200, { deviceName: device.device_name, employees: result });
}

// POST /api/kiosk/mark  Body: { employeeId }
async function kioskMark(req, res) {
  const device = authenticateDevice(req, res);
  if (!device) return;
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const employeeId = Number(body.employeeId);
  const allowed = db.prepare('SELECT 1 FROM attendance_device_employees WHERE device_id = ? AND employee_id = ?').get(device.id, employeeId);
  if (!allowed) return sendJson(res, 403, { error: 'Este colaborador no esta autorizado para marcar en este dispositivo.' });
  const result = performMark(device.organization_id, employeeId, null, 'kiosk-manual', getClientIp(req));
  sendJson(res, result.httpStatus, result.body);
}

// POST /api/kiosk/mark-by-face  Body: { descriptor: number[128] }
// Compara SOLO contra los colaboradores asignados a ESTE dispositivo (nunca
// contra el resto de la organizacion, ni contra otras organizaciones).
async function kioskMarkByFace(req, res) {
  const device = authenticateDevice(req, res);
  if (!device) return;
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  if (!validDescriptor(body.descriptor)) {
    return sendJson(res, 400, { error: 'No se pudo leer el rostro correctamente. Intenta de nuevo.' });
  }
  const profiles = db.prepare(`
    SELECT fp.employee_id, fp.descriptor_json
    FROM employee_face_profiles fp
    JOIN attendance_device_employees de ON de.employee_id = fp.employee_id AND de.device_id = ?
    WHERE fp.organization_id = ? AND fp.active = 1
  `).all(device.id, device.organization_id);

  let best = null;
  for (const p of profiles) {
    let descriptor;
    try { descriptor = JSON.parse(p.descriptor_json); } catch { continue; }
    const dist = euclideanDistance(body.descriptor, descriptor);
    if (!best || dist < best.dist) best = { employeeId: p.employee_id, dist };
  }
  if (!best || best.dist > FACE_MATCH_THRESHOLD) {
    return sendJson(res, 404, { error: 'Rostro no reconocido en este dispositivo.', state: 'no_reconocido' });
  }
  const result = performMark(device.organization_id, best.employeeId, null, 'kiosk-facial', getClientIp(req));
  sendJson(res, result.httpStatus, result.body);
}

module.exports = {
  listEmployeesToday, registerMark, listHistory, listAlerts, listFaceProfiles, enrollFaceProfile, deactivateFaceProfile, registerMarkByFace,
  listDevices, createDevice, rotateDeviceToken, deactivateDevice, getDeviceAssignments, setDeviceAssignments,
  kioskEmployeesToday, kioskMark, kioskMarkByFace,
};
