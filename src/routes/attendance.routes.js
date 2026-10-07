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
    INSERT INTO attendance_alerts (id, organization_id, employee_id, shift_date, alert_type, scheduled_time, actual_time, diff_minutes, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))
  `).run(uid('alert'), orgId, employeeId, shiftDateISO, alertType, scheduledTime || null, actualTime || null, diffMinutes == null ? null : Math.round(diffMinutes), JSON.stringify(metadata || {}));
}

function hhmmFromAbsMinutes(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = p.find(x => x.type === 'hour').value;
  const m = p.find(x => x.type === 'minute').value;
  return `${h}:${m}`;
}


// ---------------------------------------------------------------------------
// Calculo de horas (hod/hon/hed/hen) de un dia, a partir de los instantes
// exactos guardados en attendance_marks.actual_at. Lo usan el cierre del
// turno (marca de salida) y el recalculo de dias ya cerrados.
// ---------------------------------------------------------------------------
function computeDayHours({ employeeId, shiftDateISO, scheduledStart, scheduledEnd, salidaAbsMin, scheduledBreakMinutes, nightEnabled }) {
  const marks = db.prepare(
    'SELECT mark_type, actual_at FROM attendance_marks WHERE employee_id = ? AND shift_date = ? ORDER BY actual_at ASC'
  ).all(employeeId, shiftDateISO);
  const absOf = (type) => {
    const m = marks.find(x => x.mark_type === type);
    return m ? bogota.minutesSinceShiftMidnight(new Date(m.actual_at), shiftDateISO) : null;
  };

  const scheduledEntradaMin = rules.timeToMinutes(scheduledStart);
  const scheduledSalidaMin = rules.scheduledAbsoluteMinutes(scheduledEnd, scheduledStart);
  const entradaAbs = absOf('entrada');
  const salidaAbs = salidaAbsMin != null ? salidaAbsMin : absOf('salida');
  const almIni = absOf('inicio_almuerzo');
  const almFin = absOf('fin_almuerzo');
  const breakMinutes = (almIni != null && almFin != null && almFin >= almIni)
    ? (almFin - almIni)
    : (scheduledBreakMinutes || 0);

  return rules.categorizeWorkedMinutes({
    scheduledEntradaMin,
    scheduledSalidaMin,
    actualEntradaMin: entradaAbs == null ? scheduledEntradaMin : entradaAbs,
    actualSalidaMin: salidaAbs == null ? scheduledSalidaMin : salidaAbs,
    breakMinutes,
    nightSurchargeEnabled: nightEnabled !== 0,
  });
}

// Recalcula hod/hon/hed/hen de los dias YA CERRADOS con el motor corregido
// (solo se ejecuta una vez, cuando la migracion lo pide). No toca las
// marcaciones ni las alertas (son inmutables); solo los totales derivados.
function recalculateFinalizedDays() {
  const days = db.prepare(`
    SELECT d.*, e.night_surcharge AS emp_night_surcharge
    FROM attendance_days d JOIN employees e ON e.id = d.employee_id
    WHERE d.status = 'turno_finalizado' AND d.scheduled_entrada IS NOT NULL AND d.scheduled_salida IS NOT NULL
      AND COALESCE(d.corrected, 0) = 0
  `).all();
  const update = db.prepare(
    "UPDATE attendance_days SET hod_min = ?, hon_min = ?, hed_min = ?, hen_min = ?, updated_at = datetime('now') WHERE id = ?"
  );
  let count = 0;
  for (const d of days) {
    const shift = getShiftForEmployeeDate(d.organization_id, d.employee_id, d.shift_date);
    const cat = computeDayHours({
      employeeId: d.employee_id, shiftDateISO: d.shift_date,
      scheduledStart: d.scheduled_entrada, scheduledEnd: d.scheduled_salida,
      salidaAbsMin: null,
      scheduledBreakMinutes: shift ? Number(shift.breakM) || 0 : 0,
      nightEnabled: d.emp_night_surcharge === 0 ? 0 : 1,
    });
    const hedFinal = rules.applyEarlyLeaveDeduction(cat.hed, d.salida_anticipada_min || 0);
    update.run(cat.hod, cat.hon, hedFinal, cat.hen, d.id);
    count++;
  }
  return count;
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
      isSplit: !!shift.isSplit,
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
// Metodos de marcacion MANUAL: exigen motivo y generan alerta.
const MANUAL_METHODS = ['manual', 'kiosk-manual'];
function performMark(orgId, employeeId, userId, method, ip, manualReason) {
  const isManual = MANUAL_METHODS.includes(method);
  const reason = isManual ? String(manualReason || '').trim().slice(0, 300) : null;
  if (isManual && reason.length < 5) {
    return { httpStatus: 400, body: { error: 'Escribe el motivo de la marcación manual (mínimo 5 caracteres).', state: 'motivo_requerido' } };
  }
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

    // Categorizacion de horas (Regla 14) usando las marcas reales del dia,
    // con el instante exacto de cada marca (no el reloj HH:MM), para que una
    // entrada anticipada o un turno que cruza medianoche no se confundan.
    const nightEnabled = employee.night_surcharge === 0 ? 0 : 1;
    const cat = computeDayHours({
      employeeId, shiftDateISO,
      scheduledStart: shift.startTime, scheduledEnd: shift.endTime,
      salidaAbsMin: actualAbsMin,
      scheduledBreakMinutes: Number(shift.breakM) || 0,
      nightEnabled,
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
    INSERT INTO attendance_marks (id, organization_id, employee_id, shift_date, mark_type, scheduled_time, actual_at, method, marked_by_user_id, manual_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid('mark'), orgId, employeeId, shiftDateISO, markType, shift.startTime || null, nowIso, method, userId, reason);

  if (isManual) {
    const prevDay = db.prepare('SELECT manual_marks FROM attendance_days WHERE employee_id = ? AND shift_date = ?').get(employeeId, shiftDateISO);
    patch.manual_marks = ((prevDay && prevDay.manual_marks) || 0) + 1;
  }
  upsertAttendanceDay(orgId, employeeId, shiftDateISO, shift, patch);

  // Alerta "Marcacion manual": visible en la pestaña Alertas, con el motivo y
  // quien la hizo (usuario administrador o el kiosco).
  if (isManual) {
    const by = userId ? (db.prepare('SELECT email FROM users WHERE id = ?').get(userId) || {}).email : null;
    insertAlert(orgId, employeeId, shiftDateISO, 'marcacion_manual', null, actualClock, null, {
      employeeName: employee.name, markType, motivo: reason,
      origen: method === 'kiosk-manual' ? 'Kiosco (selección manual)' : 'Administrador',
      por: by || null,
    });
  }

  logAction({ organizationId: orgId, userId, action: 'attendance.mark', resourceType: 'employee', resourceId: String(employeeId), ip, metadata: { colaborador: employee.name, markType, isSplit: !!shift.isSplit, shiftDateISO, actualClock, method, ...(isManual ? { motivo: reason } : {}) } });

  return {
    httpStatus: 200,
    body: {
      ok: true,
      employeeName: employee.name,
      markType,
      // Turno partido: la suite y el kiosco muestran "Inicio/Final Etapa 1/2"
      // en lugar de Entrada/Almuerzo/Salida. El registro interno no cambia.
      isSplit: !!shift.isSplit,
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
  const result = performMark(orgId, employeeId, req.user.id, 'manual', getClientIp(req), body.reason);
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
  const employeeId = query.employeeId ? Number(query.employeeId) : null;
  const rows = db.prepare(`
    SELECT d.*, e.name as employee_name, e.night_surcharge as employee_night_surcharge
    FROM attendance_days d
    JOIN employees e ON e.id = d.employee_id
    WHERE d.organization_id = ? AND d.shift_date BETWEEN ? AND ?
      AND (? IS NULL OR d.employee_id = ?)
    ORDER BY d.shift_date DESC, e.name ASC
  `).all(orgId, from, to, employeeId, employeeId);
  // Marca qué dias eran turno partido (para mostrar "Etapa 1 / Etapa 2").
  const splitKeys = new Set();
  for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId)) {
    try {
      const sh = JSON.parse(r.data_json);
      if (sh && sh.isSplit && !sh.isOffDay) splitKeys.add(`${sh.empId}|${sh.date}`);
    } catch { /* fila invalida: se ignora */ }
  }
  for (const row of rows) row.is_split = splitKeys.has(`${row.employee_id}|${row.shift_date}`) ? 1 : 0;
  sendJson(res, 200, { rows });
}

// ---------------------------------------------------------------------------
// GET /api/attendance/my-history?from=YYYY-MM-DD&to=YYYY-MM-DD
// "Mis marcaciones": el usuario ve SOLO los dias de su propia ficha de
// colaborador (la vinculada a su usuario). Nunca acepta otro employeeId.
// ---------------------------------------------------------------------------
function listMyHistory(req, res, query) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const employeeId = req.user.employeeId != null ? Number(req.user.employeeId) : null;
  if (employeeId == null) return sendJson(res, 200, { linked: false, rows: [] });
  const to = query.to || bogota.todayISOInBogota();
  const from = query.from || bogota.addDaysISO(to, -30);
  const rows = db.prepare(`
    SELECT d.shift_date, d.status, d.scheduled_entrada, d.scheduled_salida,
           d.entrada_real, d.inicio_almuerzo_real, d.fin_almuerzo_real, d.salida_real,
           d.retraso_min, d.exceso_almuerzo_min, d.salida_anticipada_min, d.hed_min, d.hen_min, d.hon_min,
           e.name AS employee_name
    FROM attendance_days d
    JOIN employees e ON e.id = d.employee_id
    WHERE d.organization_id = ? AND d.employee_id = ? AND d.shift_date BETWEEN ? AND ?
    ORDER BY d.shift_date DESC
  `).all(orgId, employeeId, from, to);
  const splitDates = new Set();
  for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId)) {
    try {
      const sh = JSON.parse(r.data_json);
      if (sh && sh.isSplit && !sh.isOffDay && Number(sh.empId) === employeeId) splitDates.add(sh.date);
    } catch { /* fila invalida: se ignora */ }
  }
  for (const row of rows) row.is_split = splitDates.has(row.shift_date) ? 1 : 0;
  sendJson(res, 200, { linked: true, from, to, rows });
}

// ---------------------------------------------------------------------------
// GET /api/attendance/alerts?from=YYYY-MM-DD&to=YYYY-MM-DD
// ---------------------------------------------------------------------------
function listAlerts(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  scanMissingMarks(orgId);
  const from = query.from || bogota.addDaysISO(bogota.todayISOInBogota(), -7);
  const to = query.to || bogota.todayISOInBogota();
  // El apartado de Alertas muestra las novedades (las de "hora_extra" se
  // siguen calculando para la Liquidacion, pero no se muestran aqui).
  // Filtros opcionales: tipo, colaborador y estado de gestion.
  const types = ['llegada_tarde', 'exceso_almuerzo', 'salida_anticipada', 'marcacion_manual', 'inasistencia', 'turno_sin_cerrar'];
  const type = query.type && types.includes(query.type) ? query.type : null;
  const employeeId = query.employeeId ? Number(query.employeeId) : null;
  const status = ['pendiente', 'justificada', 'injustificada'].includes(query.status) ? query.status : null;
  const rows = db.prepare(`
    SELECT a.*, e.name as employee_name,
           COALESCE(m.status, 'pendiente') AS mgmt_status, m.category AS mgmt_category, m.note AS mgmt_note,
           m.attachment_name AS mgmt_attachment_name, m.managed_at AS mgmt_at, u.email AS mgmt_by
    FROM attendance_alerts a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN alert_management m ON m.alert_id = a.id
    LEFT JOIN users u ON u.id = m.managed_by
    WHERE a.organization_id = ? AND a.shift_date BETWEEN ? AND ?
      AND a.alert_type IN (${types.map(() => '?').join(',')})
      AND (? IS NULL OR a.alert_type = ?)
      AND (? IS NULL OR a.employee_id = ?)
      AND (? IS NULL OR COALESCE(m.status, 'pendiente') = ?)
    ORDER BY a.created_at DESC
  `).all(orgId, from, to, ...types, type, type, employeeId, employeeId, status, status);
  sendJson(res, 200, { rows, from, to });
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
      SET descriptor_json = ?, enrolled_by_user_id = ?, consent_given = 1, consent_at = ?, consent_text = ?, active = 1, updated_at = datetime('now', '-5 hours')
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
  db.prepare("UPDATE employee_face_profiles SET active = 0, updated_at = datetime('now', '-5 hours') WHERE employee_id = ? AND organization_id = ?").run(employeeId, orgId);
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
  // last_used_at / created_at se guardan en UTC: se muestran en hora Colombia.
  const toBog = (v) => v ? new Date(Date.parse(String(v).replace(' ', 'T') + 'Z') - 5 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : v;
  return { id: d.id, name: d.device_name, active: !!d.active, lastUsedAt: toBog(d.last_used_at), createdAt: toBog(d.created_at), health: deviceHealth(d) };
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
  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.device_assign', resourceType: 'attendance_device', resourceId: device.id, ip: getClientIp(req), metadata: { deviceName: device.device_name, count: employeeIds.length } });
  sendJson(res, 200, { ok: true, assignedCount: employeeIds.length });
}

// ---------------------------------------------------------------------------
// ENDPOINTS DEL KIOSCO -- autenticados por TOKEN DE DISPOSITIVO, nunca por
// sesion de usuario. Se registran en server.js con { auth: false } (sin
// cookie de sesion ni CSRF), y esta funcion hace su propia verificacion.
// ---------------------------------------------------------------------------
function authenticateDevice(req, res, touch = true) {
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
  if (touch) db.prepare("UPDATE attendance_devices SET last_used_at = datetime('now') WHERE id = ?").run(device.id);
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
    return { id: emp.id, name: emp.name, hasShift: true, isSplit: !!shift.isSplit, nextMark, completed: nextMark === null };
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
  const result = performMark(device.organization_id, employeeId, null, 'kiosk-manual', getClientIp(req), body.reason);
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

// ---------------------------------------------------------------------------
// GET /api/attendance/payroll-summary?from=&to=
// Entrega, por colaborador y fecha, las horas REALMENTE trabajadas (segun
// las marcaciones) dentro de un rango. Lo usa la pantalla de Liquidacion de
// horas extras para reemplazar la proyeccion del turno programado por el
// dato real, en los dias donde ya existe una marcacion completa.
// ---------------------------------------------------------------------------
function listPayrollAttendance(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const from = query.from || bogota.todayISOInBogota();
  const to = query.to || from;
  const rows = db.prepare(`
    SELECT employee_id, shift_date, status, hod_min, hon_min, hed_min, hen_min, retraso_min, exceso_almuerzo_min, salida_anticipada_min, corrected, manual_marks
    FROM attendance_days
    WHERE organization_id = ? AND shift_date BETWEEN ? AND ? AND status = 'turno_finalizado'
  `).all(orgId, from, to);
  sendJson(res, 200, { rows });
}

// ---------------------------------------------------------------------------
// CORRECCION DE MARCACIONES POR DIA (solo Administrador, motivo obligatorio)
// POST /api/attendance/corrections
//   { employeeId, date, times: { entrada, inicio_almuerzo, fin_almuerzo, salida }, reason }
// - Solo para dias ya pasados (antes de hoy, hora Colombia).
// - Las marcaciones originales NO se tocan; se guarda cada cambio (hora
//   original -> corregida) en attendance_corrections y se recalcula el dia con
//   las mismas reglas del motor (recargo, barrera de 30 min, salida anticipada).
// ---------------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
async function registerCorrection(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Fecha invalida.' });
  if (date >= bogota.todayISOInBogota()) return sendJson(res, 400, { error: 'Solo se pueden corregir dias ya pasados.' });
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo de la correccion (minimo 5 caracteres).' });
  // Un dia que pertenece a un periodo CERRADO (recargos o extras) no se puede corregir.
  const closed = db.prepare(`SELECT closure_type, period_start, period_end FROM payroll_closures
    WHERE organization_id = ? AND status = 'cerrado' AND period_start <= ? AND period_end >= ?`).all(orgId, date, date);
  if (closed.length) {
    const desc = closed.map(c => `${c.closure_type} (${c.period_start} al ${c.period_end})`).join(' y ');
    return sendJson(res, 409, { error: `Ese dia pertenece a un periodo cerrado de ${desc}. Para corregirlo, primero reabre el periodo.` });
  }
  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), orgId);
  if (!employee) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  const shift = getShiftForEmployeeDate(orgId, employee.id, date);
  if (!shift || shift.isOffDay || !shift.startTime || !shift.endTime) return sendJson(res, 400, { error: 'Ese dia el colaborador no tiene un turno con horario asignado.' });

  let day = db.prepare('SELECT * FROM attendance_days WHERE employee_id = ? AND shift_date = ?').get(employee.id, date);
  const current = {
    entrada: day ? day.entrada_real : null,
    inicio_almuerzo: day ? day.inicio_almuerzo_real : null,
    fin_almuerzo: day ? day.fin_almuerzo_real : null,
    salida: day ? day.salida_real : null,
  };
  const times = body.times && typeof body.times === 'object' ? body.times : {};
  const final = {};
  for (const k of rules.MARK_SEQUENCE) {
    const v = times[k] != null && times[k] !== '' ? String(times[k]) : current[k];
    if (!v || !HHMM.test(v)) return sendJson(res, 400, { error: 'Completa las 4 horas del dia en formato HH:MM.' });
    final[k] = v;
  }

  // Minutos absolutos desde la medianoche del dia del turno (cruza medianoche si hace falta).
  const scheduledEntradaMin = rules.timeToMinutes(shift.startTime);
  const scheduledSalidaMin = rules.scheduledAbsoluteMinutes(shift.endTime, shift.startTime);
  const abs = {};
  let prev = null;
  for (const k of rules.MARK_SEQUENCE) {
    let m = rules.timeToMinutes(final[k]);
    if (prev === null) {
      if (m < scheduledEntradaMin - 720) m += 1440; // entrada pasada la medianoche de un turno nocturno
    } else {
      while (m < prev) m += 1440;
    }
    abs[k] = m;
    prev = m;
  }
  if (abs.salida - abs.entrada > 24 * 60) return sendJson(res, 400, { error: 'Las horas no forman una jornada valida (mas de 24 horas).' });

  const breakMinutes = abs.fin_almuerzo - abs.inicio_almuerzo;
  const nightEnabled = employee.night_surcharge === 0 ? 0 : 1;
  const cat = rules.categorizeWorkedMinutes({
    scheduledEntradaMin, scheduledSalidaMin,
    actualEntradaMin: abs.entrada, actualSalidaMin: abs.salida,
    breakMinutes, nightSurchargeEnabled: nightEnabled !== 0,
  });
  const retraso = Math.max(0, abs.entrada - scheduledEntradaMin);
  const exceso = rules.classifyAlmuerzo(Number(shift.breakM) || 0, breakMinutes).excessMinutes;
  const adeudado = rules.classifySalida(scheduledSalidaMin, abs.salida).adeudadoMinutes;
  const hedFinal = rules.applyEarlyLeaveDeduction(cat.hed, adeudado);

  if (!day) {
    db.prepare(`INSERT INTO attendance_days (id, organization_id, employee_id, shift_date, status, scheduled_entrada, scheduled_salida)
                VALUES (?, ?, ?, ?, 'pendiente_entrada', ?, ?)`).run(uid('att'), orgId, employee.id, date, shift.startTime, shift.endTime);
  }
  db.prepare(`
    UPDATE attendance_days SET
      entrada_real = ?, inicio_almuerzo_real = ?, fin_almuerzo_real = ?, salida_real = ?,
      scheduled_entrada = COALESCE(scheduled_entrada, ?), scheduled_salida = COALESCE(scheduled_salida, ?),
      retraso_min = ?, exceso_almuerzo_min = ?, salida_anticipada_min = ?,
      hod_min = ?, hon_min = ?, hed_min = ?, hen_min = ?,
      status = 'turno_finalizado', corrected = 1, updated_at = datetime('now')
    WHERE employee_id = ? AND shift_date = ?
  `).run(final.entrada, final.inicio_almuerzo, final.fin_almuerzo, final.salida,
    shift.startTime, shift.endTime, retraso, exceso, adeudado,
    cat.hod, cat.hon, hedFinal, cat.hen, employee.id, date);

  const insertCorr = db.prepare(`INSERT INTO attendance_corrections (id, organization_id, employee_id, shift_date, mark_type, original_time, corrected_time, reason, created_by, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))`);
  const changes = [];
  for (const k of rules.MARK_SEQUENCE) {
    if (current[k] !== final[k]) {
      insertCorr.run(uid('corr'), orgId, employee.id, date, k, current[k], final[k], reason, req.user.id);
      changes.push({ marcacion: k, antes: current[k], despues: final[k] });
    }
  }
  logAction({
    organizationId: orgId, userId: req.user.id, action: 'attendance.correction',
    resourceType: 'employee', resourceId: String(employee.id), ip: getClientIp(req),
    metadata: { colaborador: employee.name, fecha: date, cambios: changes, motivo: reason },
  });
  sendJson(res, 200, { ok: true, changes, hours: { hod_min: cat.hod, hon_min: cat.hon, hed_min: hedFinal, hen_min: cat.hen } });
}

// GET /api/attendance/corrections?from=&to=[&employeeId=]
function listCorrections(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const to = query.to || bogota.todayISOInBogota();
  const from = query.from || bogota.addDaysISO(to, -31);
  const employeeId = query.employeeId ? Number(query.employeeId) : null;
  const rows = db.prepare(`
    SELECT c.employee_id, c.shift_date, c.mark_type, c.original_time, c.corrected_time, c.reason, c.created_at, u.email AS created_by_email
    FROM attendance_corrections c LEFT JOIN users u ON u.id = c.created_by
    WHERE c.organization_id = ? AND c.shift_date BETWEEN ? AND ? AND (? IS NULL OR c.employee_id = ?)
    ORDER BY c.created_at DESC
  `).all(orgId, from, to, employeeId, employeeId);
  sendJson(res, 200, { rows });
}

// ===========================================================================
// FASE 1 y 2 DE ASISTENCIA: tablero "Hoy", alertas automaticas de
// "No se presento" / "Turno sin cerrar" y gestion de novedades.
// Todo es ADICIONAL: no cambia como se marca, ni como se calculan las horas,
// ni las alertas que ya existian (que siguen siendo inmutables).
// ===========================================================================
const NO_SHOW_TOLERANCE_MIN = 15;   // minutos despues de la entrada para mostrar "No ha llegado"
const OPEN_SHIFT_GRACE_MIN = 60;    // tablero Hoy: minutos despues de la salida programada para mostrar "Sin marcar salida"
const OPEN_SHIFT_ALERT_MIN = 300;   // alerta "Turno sin cerrar": 5 horas despues de la salida programada (margen para que marque)
const ABSENCE_LABELS = { vacaciones: 'Vacaciones', incapacidad: 'Incapacidad', sin_horario: 'Sin horario' };

// Fecha desde la cual se generan las alertas automaticas nuevas (el dia en
// que se instala esta version), para no crear alertas sobre el pasado.
const NOVEDADES_FEATURE = 'novedades_scan_v1';
if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(NOVEDADES_FEATURE)) {
  db.prepare("INSERT INTO app_migrations (name, applied_at) VALUES (?, datetime('now', '-5 hours'))").run(NOVEDADES_FEATURE);
}
const NOVEDADES_START = String((db.prepare('SELECT applied_at FROM app_migrations WHERE name = ?').get(NOVEDADES_FEATURE) || {}).applied_at || '').slice(0, 10);

function shiftsByKey(orgId) {
  const map = new Map();
  for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId)) {
    try {
      const s = JSON.parse(r.data_json);
      if (s && s.empId != null && s.date) map.set(`${Number(s.empId)}|${s.date}`, s);
    } catch { /* fila invalida: se ignora */ }
  }
  return map;
}

function isWorkShift(s) {
  return !!(s && !s.isOffDay && rules.timeToMinutes(s.startTime) != null && rules.timeToMinutes(s.endTime) != null);
}

// Minutos (desde la medianoche del dia del turno) de un reloj HH:MM que
// pertenece al turno (si es menor que la entrada, es del dia siguiente).
function clockToRel(hhmm, startHHMM) {
  return rules.scheduledAbsoluteMinutes(hhmm, startHHMM);
}

function fmtMin(m) {
  m = Math.max(0, Math.round(m));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h ${String(r).padStart(2, '0')} min` : `${r} min`;
}

function getDayZero(orgId) {
  try {
    const r = db.prepare('SELECT day_zero FROM org_settings WHERE organization_id = ?').get(orgId);
    return r && r.day_zero ? r.day_zero : null;
  } catch { return null; }
}

// Revisa los ultimos 3 dias y crea (UNA sola vez por colaborador y dia):
//  - 'inasistencia': el turno ya termino y no hubo ninguna marcacion de entrada.
//  - 'turno_sin_cerrar': marco entrada pero, 5 horas despues de la salida
//    programada, todavia no marca salida.
const lastScanAt = new Map();
function scanMissingMarks(orgId, force = false) {
  const nowMs = Date.now();
  if (!force && lastScanAt.has(orgId) && nowMs - lastScanAt.get(orgId) < 60000) return;
  lastScanAt.set(orgId, nowMs);
  try {
    const now = new Date();
    const today = bogota.todayISOInBogota(now);
    const dayZero = getDayZero(orgId);
    const shifts = shiftsByKey(orgId);
    const employees = db.prepare('SELECT id, name FROM employees WHERE organization_id = ?').all(orgId);
    const existsAlert = db.prepare('SELECT 1 FROM attendance_alerts WHERE employee_id = ? AND shift_date = ? AND alert_type = ?');
    const dayRow = db.prepare('SELECT entrada_real, salida_real, status FROM attendance_days WHERE employee_id = ? AND shift_date = ?');
    const markTypes = db.prepare('SELECT mark_type FROM attendance_marks WHERE employee_id = ? AND shift_date = ?');
    for (let back = 3; back >= 0; back--) {
      const date = bogota.addDaysISO(today, -back);
      if (NOVEDADES_START && date < NOVEDADES_START) continue;
      if (dayZero && date <= dayZero) continue;
      for (const emp of employees) {
        const s = shifts.get(`${emp.id}|${date}`);
        if (!isWorkShift(s)) continue;
        const endRel = clockToRel(s.endTime, s.startTime);
        const nowRel = bogota.minutesSinceShiftMidnight(now, date);
        if (nowRel < endRel) continue; // el turno aun no termina
        const d = dayRow.get(emp.id, date);
        const types = new Set(markTypes.all(emp.id, date).map(r => r.mark_type));
        const hasEntrada = types.has('entrada') || !!(d && d.entrada_real);
        const hasSalida = types.has('salida') || !!(d && d.salida_real) || (d && d.status === 'turno_finalizado');
        if (!hasEntrada) {
          if (!existsAlert.get(emp.id, date, 'inasistencia')) {
            insertAlert(orgId, emp.id, date, 'inasistencia', s.startTime, null, null, {
              employeeName: emp.name, turno: `${s.startTime} - ${s.endTime}`,
            });
          }
        } else if (!hasSalida && nowRel >= endRel + OPEN_SHIFT_ALERT_MIN) {
          if (!existsAlert.get(emp.id, date, 'turno_sin_cerrar')) {
            insertAlert(orgId, emp.id, date, 'turno_sin_cerrar', s.endTime, null, null, {
              employeeName: emp.name, turno: `${s.startTime} - ${s.endTime}`,
              entrada: d && d.entrada_real ? d.entrada_real : null,
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[asistencia] Revision de marcaciones faltantes:', e.message);
  }
}

// Revision periodica (cada 5 minutos) para todas las organizaciones activas,
// asi las alertas aparecen aunque nadie abra el modulo.
const scanTimer = setInterval(() => {
  try {
    for (const o of db.prepare('SELECT DISTINCT organization_id AS id FROM employees').all()) scanMissingMarks(o.id, true);
  } catch { /* nada */ }
}, 5 * 60 * 1000);
if (scanTimer.unref) scanTimer.unref();

// ---------------------------------------------------------------------------
// GET /api/attendance/today  -- tablero "Hoy" en tiempo real.
// ---------------------------------------------------------------------------
function todayBoard(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  scanMissingMarks(orgId);
  const now = new Date();
  const today = bogota.todayISOInBogota(now);
  const yesterday = bogota.addDaysISO(today, -1);
  const shifts = shiftsByKey(orgId);
  const employees = db.prepare('SELECT id, name, role, department FROM employees WHERE organization_id = ? ORDER BY name ASC').all(orgId);
  const dayRow = db.prepare('SELECT * FROM attendance_days WHERE employee_id = ? AND shift_date = ?');
  const lunchMark = db.prepare("SELECT actual_at FROM attendance_marks WHERE employee_id = ? AND shift_date = ? AND mark_type = 'inicio_almuerzo' ORDER BY actual_at ASC LIMIT 1");

  const people = [];
  const absences = [];

  const evaluate = (emp, s, date) => {
    const startRel = rules.timeToMinutes(s.startTime);
    const endRel = clockToRel(s.endTime, s.startTime);
    const nowRel = bogota.minutesSinceShiftMidnight(now, date);
    const d = dayRow.get(emp.id, date);
    let status, label;
    if (d && (d.salida_real || d.status === 'turno_finalizado')) {
      status = 'finalizado'; label = d.salida_real ? `Salió ${d.salida_real}` : 'Turno finalizado';
    } else if (!d || !d.entrada_real) {
      if (nowRel < startRel) { status = 'por_iniciar'; label = `Inicia ${s.startTime}`; }
      else if (nowRel < startRel + NO_SHOW_TOLERANCE_MIN) { status = 'en_espera'; label = `Debía llegar ${s.startTime}`; }
      else if (nowRel >= endRel) { status = 'no_llego'; label = 'No se presentó'; }
      else { status = 'no_llego'; label = `Lleva ${fmtMin(nowRel - startRel)} de retraso (entrada ${s.startTime})`; }
    } else if (nowRel >= endRel + OPEN_SHIFT_GRACE_MIN) {
      status = 'sin_cerrar'; label = `Debía salir a las ${s.endTime}`;
    } else if (d.inicio_almuerzo_real && !d.fin_almuerzo_real) {
      const lm = lunchMark.get(emp.id, date);
      const used = lm ? Math.max(0, Math.round((now.getTime() - Date.parse(lm.actual_at)) / 60000)) : 0;
      const allowed = Number(s.breakM) || 0;
      if (allowed && used > allowed) { status = 'almuerzo_largo'; label = `En almuerzo ${fmtMin(used)} (permitido ${allowed} min)`; }
      else { status = 'almuerzo'; label = `En almuerzo desde ${d.inicio_almuerzo_real}`; }
    } else if ((d.retraso_min || 0) > 0) {
      status = 'tarde'; label = `Llegó ${d.entrada_real} (+${fmtMin(d.retraso_min)})`;
    } else {
      status = 'presente'; label = `Llegó ${d.entrada_real}`;
    }
    const expectedNow = nowRel >= startRel && nowRel < endRel;
    people.push({
      id: emp.id, name: emp.name, role: emp.role, department: emp.department || 'Sin área',
      shiftDate: date, scheduled: `${s.startTime} - ${s.endTime}`, isSplit: !!s.isSplit,
      status, label, expectedNow,
    });
  };

  for (const emp of employees) {
    // Turno nocturno de ayer que sigue abierto (aun no marca salida).
    const sy = shifts.get(`${emp.id}|${yesterday}`);
    if (isWorkShift(sy) && isOvernightShift(sy)) {
      const dy = dayRow.get(emp.id, yesterday);
      if (dy && dy.entrada_real && !dy.salida_real && dy.status !== 'turno_finalizado') evaluate(emp, sy, yesterday);
    }
    const s = shifts.get(`${emp.id}|${today}`);
    if (!s) continue;
    if (s.isOffDay) {
      if (s.absenceType && ABSENCE_LABELS[s.absenceType]) {
        absences.push({ id: emp.id, name: emp.name, department: emp.department || 'Sin área', type: s.absenceType, label: ABSENCE_LABELS[s.absenceType] });
      }
      continue;
    }
    if (isWorkShift(s)) evaluate(emp, s, today);
  }

  const c = (fn) => people.filter(fn).length;
  const PRESENT = new Set(['presente', 'tarde', 'almuerzo', 'almuerzo_largo']);
  const counters = {
    programados: people.length,
    presentes: c(p => PRESENT.has(p.status)),
    tarde: c(p => p.status === 'tarde'),
    almuerzo: c(p => p.status === 'almuerzo' || p.status === 'almuerzo_largo'),
    noLlego: c(p => p.status === 'no_llego'),
    porIniciar: c(p => p.status === 'por_iniciar' || p.status === 'en_espera'),
    finalizados: c(p => p.status === 'finalizado'),
    sinCerrar: c(p => p.status === 'sin_cerrar'),
    ausencias: absences.length,
  };
  const areaMap = new Map();
  for (const p of people) {
    if (!areaMap.has(p.department)) areaMap.set(p.department, { name: p.department, total: 0, present: 0, expectedNow: 0, people: [] });
    const a = areaMap.get(p.department);
    a.total++;
    if (PRESENT.has(p.status)) a.present++;
    if (p.expectedNow) a.expectedNow++;
    a.people.push(p);
  }
  const areas = [...areaMap.values()].sort((x, y) => x.name.localeCompare(y.name, 'es'));
  sendJson(res, 200, {
    date: today, now: hhmmFromAbsMinutes(now), counters, areas, absences, devices: devicesWithProblems(orgId),
    tolerance: NO_SHOW_TOLERANCE_MIN, grace: OPEN_SHIFT_GRACE_MIN,
  });
}

// ---------------------------------------------------------------------------
// POST /api/attendance/alerts/:id/manage
//  { status: 'pendiente'|'justificada'|'injustificada', category, note,
//    attachment: { name, type, data(base64) } | null, removeAttachment }
// La alerta original NO se toca; la gestion se guarda en alert_management.
// ---------------------------------------------------------------------------
const MGMT_STATUSES = ['pendiente', 'justificada', 'injustificada'];
const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const MGMT_LABELS = { pendiente: 'Pendiente', justificada: 'Justificada', injustificada: 'Injustificada' };
async function manageAlert(req, res, params) {
  let body;
  try { body = await readBody(req, 6 * 1024 * 1024); } catch (e) {
    return sendJson(res, e && e.message === 'payload_too_large' ? 413 : 400, { error: e && e.message === 'payload_too_large' ? 'El archivo es demasiado grande (máximo 3 MB).' : 'JSON invalido' });
  }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const alert = db.prepare(`SELECT a.*, e.name AS employee_name FROM attendance_alerts a JOIN employees e ON e.id = a.employee_id
                            WHERE a.id = ? AND a.organization_id = ?`).get(String(params.id), orgId);
  if (!alert) return sendJson(res, 404, { error: 'Alerta no encontrada.' });
  const status = String(body.status || '');
  if (!MGMT_STATUSES.includes(status)) return sendJson(res, 400, { error: 'Elige si la novedad queda justificada, injustificada o pendiente.' });
  const note = String(body.note || '').trim().slice(0, 600);
  // Justificada: la nota es obligatoria (por que se justifica). Injustificada: la nota es opcional.
  if (status === 'justificada' && note.length < 5) return sendJson(res, 400, { error: 'Para justificar escribe una nota (mínimo 5 caracteres).' });
  const category = String(body.category || '').trim().slice(0, 60) || null;

  const prev = db.prepare('SELECT * FROM alert_management WHERE alert_id = ?').get(alert.id);
  let attName = prev ? prev.attachment_name : null;
  let attType = prev ? prev.attachment_type : null;
  let attData = prev ? prev.attachment_data : null;
  if (body.removeAttachment) { attName = null; attType = null; attData = null; }
  if (body.attachment && body.attachment.data) {
    const t = String(body.attachment.type || '').toLowerCase();
    if (!ATTACH_TYPES.includes(t)) return sendJson(res, 400, { error: 'El soporte debe ser una imagen (PNG, JPG, WEBP) o un PDF.' });
    const data = String(body.attachment.data).replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) return sendJson(res, 400, { error: 'El archivo adjunto no es valido.' });
    const bytes = Math.floor(data.replace(/\s/g, '').length * 3 / 4);
    if (bytes > 3 * 1024 * 1024) return sendJson(res, 400, { error: 'El archivo es demasiado grande (máximo 3 MB).' });
    attName = String(body.attachment.name || 'soporte').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    attType = t;
    attData = data.replace(/\s/g, '');
  }

  db.prepare(`
    INSERT INTO alert_management (alert_id, organization_id, status, category, note, attachment_name, attachment_type, attachment_data, managed_by, managed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))
    ON CONFLICT(alert_id) DO UPDATE SET status = excluded.status, category = excluded.category, note = excluded.note,
      attachment_name = excluded.attachment_name, attachment_type = excluded.attachment_type, attachment_data = excluded.attachment_data,
      managed_by = excluded.managed_by, managed_at = excluded.managed_at
  `).run(alert.id, orgId, status, category, note || null, attName, attType, attData, req.user.id);

  logAction({
    organizationId: orgId, userId: req.user.id, action: 'attendance.alert_managed',
    resourceType: 'employee', resourceId: String(alert.employee_id), ip: getClientIp(req),
    metadata: {
      colaborador: alert.employee_name, fecha: alert.shift_date, tipo: alert.alert_type,
      estado: MGMT_LABELS[status], estadoAnterior: prev ? MGMT_LABELS[prev.status] : 'Pendiente',
      categoria: category, nota: note || null, soporte: attName || null,
    },
  });
  sendJson(res, 200, { ok: true, status, hasAttachment: !!attData });
}

// GET /api/attendance/alerts/:id/attachment -- descarga el soporte adjunto.
function getAlertAttachment(req, res, params) {
  const orgId = resolveOrgId(req, {});
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const row = db.prepare('SELECT attachment_name, attachment_type, attachment_data FROM alert_management WHERE alert_id = ? AND organization_id = ?').get(String(params.id), orgId);
  if (!row || !row.attachment_data) return sendJson(res, 404, { error: 'Esta novedad no tiene soporte adjunto.' });
  const buf = Buffer.from(row.attachment_data, 'base64');
  res.writeHead(200, {
    'Content-Type': row.attachment_type || 'application/octet-stream',
    'Content-Length': buf.length,
    'Content-Disposition': `inline; filename="${encodeURIComponent(row.attachment_name || 'soporte')}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

// ---------------------------------------------------------------------------
// GET /api/attendance/novedades?from=&to=  -- resumen por colaborador.
// ---------------------------------------------------------------------------
const NOVEDAD_TYPES = ['llegada_tarde', 'exceso_almuerzo', 'salida_anticipada', 'inasistencia', 'turno_sin_cerrar', 'marcacion_manual'];
function novedadesSummary(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  scanMissingMarks(orgId);
  const to = query.to || bogota.todayISOInBogota();
  const from = query.from || bogota.addDaysISO(to, -30);
  const rows = db.prepare(`
    SELECT a.employee_id, a.alert_type, a.diff_minutes, COALESCE(m.status, 'pendiente') AS mgmt_status
    FROM attendance_alerts a LEFT JOIN alert_management m ON m.alert_id = a.id
    WHERE a.organization_id = ? AND a.shift_date BETWEEN ? AND ?
      AND a.alert_type IN (${NOVEDAD_TYPES.map(() => '?').join(',')})
  `).all(orgId, from, to, ...NOVEDAD_TYPES);
  const employees = db.prepare('SELECT id, name, role, department FROM employees WHERE organization_id = ? ORDER BY name ASC').all(orgId);
  const by = new Map(employees.map(e => [e.id, {
    employeeId: e.id, name: e.name, role: e.role, department: e.department || 'Sin área',
    llegada_tarde: 0, exceso_almuerzo: 0, salida_anticipada: 0, inasistencia: 0, turno_sin_cerrar: 0, marcacion_manual: 0,
    minutesLate: 0, total: 0, pendiente: 0, justificada: 0, injustificada: 0,
  }]));
  for (const r of rows) {
    const o = by.get(r.employee_id);
    if (!o) continue;
    o[r.alert_type]++;
    o.total++;
    o[r.mgmt_status] = (o[r.mgmt_status] || 0) + 1;
    if (r.alert_type === 'llegada_tarde') o.minutesLate += Math.max(0, r.diff_minutes || 0);
  }
  const list = [...by.values()].filter(o => o.total > 0).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'es'));
  sendJson(res, 200, { from, to, rows: list });
}

// ===========================================================================
// FASE 3: INDICADORES DE ASISTENCIA + RESUMEN DIARIO POR CORREO
// Solo LEE datos existentes (turnos, dias de asistencia, alertas y su
// gestion). No modifica nada de lo que ya calcula la suite.
// ===========================================================================
const ISO_D = /^\d{4}-\d{2}-\d{2}$/;
function monthlyDividerForDate(dateISO) {
  if (dateISO >= '2026-07-15') return 210;
  if (dateISO >= '2025-07-15') return 220;
  if (dateISO >= '2024-07-15') return 230;
  return 240;
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

// Carga UNA vez los datos de la organizacion necesarios para los indicadores.
function loadIndicatorData(orgId, from, to) {
  const employees = new Map(db.prepare('SELECT id, name, department, salary FROM employees WHERE organization_id = ?').all(orgId)
    .map(e => [e.id, { ...e, department: e.department || 'Sin área' }]));
  const shifts = [];
  const incapDays = [];          // { empId, date } de TODAS las fechas (para agrupar episodios)
  const workKeys = new Set();    // empId|date con turno de trabajo (corta un episodio)
  for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ?').all(orgId)) {
    try {
      const s = JSON.parse(r.data_json);
      if (!s || !s.date) continue;
      if (isWorkShift(s)) {
        workKeys.add(`${Number(s.empId)}|${s.date}`);
        if (s.date >= from && s.date <= to) shifts.push(s);
      } else if (s.isOffDay && s.absenceType === 'incapacidad') {
        incapDays.push({ empId: Number(s.empId), date: s.date });
      }
    } catch { /* fila invalida */ }
  }
  const days = new Map(db.prepare(`SELECT employee_id, shift_date, status, entrada_real, salida_real, retraso_min, exceso_almuerzo_min,
      salida_anticipada_min, hed_min, hen_min FROM attendance_days WHERE organization_id = ? AND shift_date BETWEEN ? AND ?`)
    .all(orgId, from, to).map(d => [`${d.employee_id}|${d.shift_date}`, d]));
  const alerts = db.prepare(`SELECT a.employee_id, a.shift_date, a.alert_type, COALESCE(m.status, 'pendiente') AS mgmt
      FROM attendance_alerts a LEFT JOIN alert_management m ON m.alert_id = a.id
      WHERE a.organization_id = ? AND a.shift_date BETWEEN ? AND ?
        AND a.alert_type IN ('llegada_tarde','exceso_almuerzo','salida_anticipada','inasistencia','turno_sin_cerrar','marcacion_manual')`)
    .all(orgId, from, to);
  const mw = db.prepare('SELECT minimum_wage FROM org_settings WHERE organization_id = ?').get(orgId);
  return { employees, shifts, days, alerts, dayZero: getDayZero(orgId), incapacityEpisodes: buildIncapacityEpisodes(incapDays, workKeys), minimumWage: (mw && Number(mw.minimum_wage)) || 1750905 };
}

// Agrupa los dias de incapacidad de cada colaborador en EPISODIOS (una misma
// incapacidad): dias seguidos, permitiendo saltar dias SIN turno de trabajo
// (descansos, domingos). Cada dia queda con su numero dentro del episodio
// (1, 2, 3...), para saber cuales son los 2 primeros dias (a cargo del empleador).
function buildIncapacityEpisodes(incapDays, workKeys) {
  const byEmp = new Map();
  for (const d of incapDays) {
    if (!byEmp.has(d.empId)) byEmp.set(d.empId, new Set());
    byEmp.get(d.empId).add(d.date);
  }
  const episodes = [];
  for (const [empId, set] of byEmp) {
    const dates = [...set].sort();
    let cur = null;
    for (const date of dates) {
      let continues = false;
      if (cur) {
        continues = true;
        for (let x = bogota.addDaysISO(cur.end, 1); x < date; x = bogota.addDaysISO(x, 1)) {
          if (workKeys.has(`${empId}|${x}`)) { continues = false; break; }
        }
        if (daysBetween(cur.end, date) > 7) continues = false;
      }
      if (!continues) { cur = { empId, start: date, end: date, days: [] }; episodes.push(cur); }
      cur.end = date;
      cur.days.push({ date, n: cur.days.length + 1 });
    }
  }
  return episodes;
}

function emptyBucket(name) {
  return { name, programados: 0, asistidos: 0, ausencias: 0, ausenciasJustificadas: 0, entradas: 0, tarde: 0,
    minutosRetraso: 0, minutosPerdidos: 0, costoPerdido: 0, extraDiurnaMin: 0, extraNocturnaMin: 0, sinCerrar: 0, manuales: 0 };
}
function finishBucket(b) {
  const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : null;
  b.ausentismo = pct(b.ausencias, b.programados);
  b.ausentismoInjustificado = pct(b.ausencias - b.ausenciasJustificadas, b.programados);
  b.puntualidad = pct(b.entradas - b.tarde, b.entradas);
  b.costoPerdido = Math.round(b.costoPerdido);
  b.extraTotalMin = b.extraDiurnaMin + b.extraNocturnaMin;
  return b;
}

// Calcula los indicadores de un rango usando datos ya cargados.
function computeIndicators(data, from, to, area, now) {
  const today = bogota.todayISOInBogota(now);
  const total = emptyBucket('Total');
  const byArea = new Map();
  const bucketsFor = (emp) => {
    const name = emp.department;
    if (!byArea.has(name)) byArea.set(name, emptyBucket(name));
    return [total, byArea.get(name)];
  };
  const justifiedAbs = new Set(data.alerts.filter(a => a.alert_type === 'inasistencia' && a.mgmt === 'justificada').map(a => `${a.employee_id}|${a.shift_date}`));

  for (const s of data.shifts) {
    if (s.date < from || s.date > to || s.date > today) continue;
    if (data.dayZero && s.date <= data.dayZero) continue;
    const emp = data.employees.get(Number(s.empId));
    if (!emp || (area && emp.department !== area)) continue;
    // Solo turnos que YA terminaron (los que estan en curso aun no se evaluan).
    const endRel = clockToRel(s.endTime, s.startTime);
    if (bogota.minutesSinceShiftMidnight(now, s.date) < endRel) continue;
    const key = `${emp.id}|${s.date}`;
    const d = data.days.get(key);
    const bs = bucketsFor(emp);
    const valorMinuto = (Number(emp.salary) || 0) / monthlyDividerForDate(s.date) / 60;
    for (const b of bs) b.programados++;
    if (!d || !d.entrada_real) {
      for (const b of bs) { b.ausencias++; if (justifiedAbs.has(key)) b.ausenciasJustificadas++; }
      continue;
    }
    const lost = (d.retraso_min || 0) + (d.exceso_almuerzo_min || 0) + (d.salida_anticipada_min || 0);
    for (const b of bs) {
      b.asistidos++; b.entradas++;
      if ((d.retraso_min || 0) > 0) { b.tarde++; b.minutosRetraso += d.retraso_min; }
      b.minutosPerdidos += lost;
      b.costoPerdido += lost * valorMinuto;
    }
  }
  // Horas extra de los dias cerrados (saldo positivo de extra diurna + extra nocturna).
  for (const d of data.days.values()) {
    if (d.shift_date < from || d.shift_date > to || d.status !== 'turno_finalizado') continue;
    if (data.dayZero && d.shift_date <= data.dayZero) continue;
    const emp = data.employees.get(d.employee_id);
    if (!emp || (area && emp.department !== area)) continue;
    for (const b of bucketsFor(emp)) { b.extraDiurnaMin += Math.max(0, d.hed_min || 0); b.extraNocturnaMin += Math.max(0, d.hen_min || 0); }
  }
  for (const a of data.alerts) {
    if (a.shift_date < from || a.shift_date > to) continue;
    const emp = data.employees.get(a.employee_id);
    if (!emp || (area && emp.department !== area)) continue;
    if (a.alert_type === 'turno_sin_cerrar') for (const b of bucketsFor(emp)) b.sinCerrar++;
    if (a.alert_type === 'marcacion_manual') for (const b of bucketsFor(emp)) b.manuales++;
  }
  return {
    total: finishBucket(total),
    areas: [...byArea.values()].map(finishBucket).sort((a, b) => a.name.localeCompare(b.name, 'es')),
  };
}

// Incapacidades del periodo (dias marcados como "Incapacidad" en el cuadro de
// turnos, hasta hoy). Costo en salario = salario mensual / 30 por dia.
// Estimado a cargo de la empresa (origen comun): los 2 primeros dias de cada
// incapacidad, pagados al 66,67 % del salario sin bajar del salario minimo
// diario (art. 227 CST y Decreto 2943 de 2013). Los demas dias los reconoce la EPS.
function computeIncapacities(data, from, to, area, now) {
  const today = bogota.todayISOInBogota(now);
  const end = to < today ? to : today;
  const minDaily = data.minimumWage / 30;
  const byEmp = new Map();
  const byArea = new Map();
  const total = { dias: 0, episodios: 0, colaboradores: 0, costoSalario: 0, diasEmpresa: 0, valorEmpresa: 0 };
  for (const ep of data.incapacityEpisodes) {
    const emp = data.employees.get(ep.empId);
    if (!emp || (area && emp.department !== area)) continue;
    const inRange = ep.days.filter(d => d.date >= from && d.date <= end && !(data.dayZero && d.date <= data.dayZero));
    if (!inRange.length) continue;
    const daily = (Number(emp.salary) || 0) / 30;
    const companyDaily = Math.max(daily * 2 / 3, minDaily);
    if (!byEmp.has(emp.id)) byEmp.set(emp.id, { employeeId: emp.id, name: emp.name, department: emp.department, salary: Number(emp.salary) || 0,
      dias: 0, episodios: 0, costoSalario: 0, diasEmpresa: 0, valorEmpresa: 0, ultima: null, periodos: [] });
    const e = byEmp.get(emp.id);
    const companyDays = inRange.filter(d => d.n <= 2).length;
    e.dias += inRange.length; e.episodios++;
    e.costoSalario += inRange.length * daily;
    e.diasEmpresa += companyDays; e.valorEmpresa += companyDays * companyDaily;
    e.periodos.push({ desde: ep.start, hasta: ep.end, dias: ep.days.length });
    if (!e.ultima || ep.start > e.ultima) e.ultima = ep.start;
    if (!byArea.has(emp.department)) byArea.set(emp.department, { dias: 0, costoSalario: 0 });
    const a = byArea.get(emp.department);
    a.dias += inRange.length; a.costoSalario += inRange.length * daily;
  }
  const employees = [...byEmp.values()].map(e => ({ ...e, costoSalario: Math.round(e.costoSalario), valorEmpresa: Math.round(e.valorEmpresa) }));
  for (const e of employees) {
    total.dias += e.dias; total.episodios += e.episodios; total.costoSalario += e.costoSalario;
    total.diasEmpresa += e.diasEmpresa; total.valorEmpresa += e.valorEmpresa;
  }
  total.colaboradores = employees.length;
  employees.sort((a, b) => b.dias - a.dias || b.episodios - a.episodios || a.name.localeCompare(b.name, 'es'));
  return { total, employees, byArea: Object.fromEntries([...byArea].map(([k, v]) => [k, { dias: v.dias, costoSalario: Math.round(v.costoSalario) }])) };
}

// GET /api/attendance/indicators?from=&to=&area=
function indicators(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  scanMissingMarks(orgId);
  const now = new Date();
  const today = bogota.todayISOInBogota(now);
  const to = ISO_D.test(query.to || '') ? query.to : today;
  const from = ISO_D.test(query.from || '') ? query.from : to.slice(0, 8) + '01';
  if (from > to) return sendJson(res, 400, { error: 'La fecha inicial no puede ser mayor que la final.' });
  if (daysBetween(from, to) > 400) return sendJson(res, 400, { error: 'El rango máximo es de 13 meses.' });
  const area = query.area ? String(query.area) : '';

  // Periodo anterior de la misma duracion, para comparar.
  const len = daysBetween(from, to) + 1;
  const prevTo = bogota.addDaysISO(from, -1);
  const prevFrom = bogota.addDaysISO(from, -len);
  // Tendencia: los ultimos 6 meses hasta el mes de "Hasta".
  const months = [];
  const [ty, tm] = to.split('-').map(Number);
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(Date.UTC(ty, tm - 1 - i, 1));
    const mFrom = dt.toISOString().slice(0, 10);
    const mEnd = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    months.push({ from: mFrom, to: mEnd < today ? mEnd : today, label: mFrom.slice(0, 7) });
  }
  const loadFrom = [prevFrom, months[0].from, from].sort()[0];
  const data = loadIndicatorData(orgId, loadFrom, to > today ? today : to);

  const current = computeIndicators(data, from, to, area, now);
  const previous = computeIndicators(data, prevFrom, prevTo, area, now).total;
  // Incapacidades: dias, costo y tasa (dias de incapacidad sobre dias programados + incapacidad).
  const incap = computeIncapacities(data, from, to, area, now);
  const incapPrev = computeIncapacities(data, prevFrom, prevTo, area, now).total;
  const tasaInc = (dias, prog) => (dias + prog) ? Math.round((dias / (dias + prog)) * 1000) / 10 : null;
  incap.total.tasa = tasaInc(incap.total.dias, current.total.programados);
  incapPrev.tasa = tasaInc(incapPrev.dias, previous.programados);
  for (const a of current.areas) {
    const x = incap.byArea[a.name] || { dias: 0, costoSalario: 0 };
    a.incapacidadDias = x.dias; a.incapacidadCosto = x.costoSalario;
  }
  current.total.incapacidadDias = incap.total.dias; current.total.incapacidadCosto = incap.total.costoSalario;
  const trend = months.filter(m => m.from <= today).map(m => {
    const t = computeIndicators(data, m.from, m.to, area, now).total;
    const inc = computeIncapacities(data, m.from, m.to, area, now).total;
    return { month: m.label, ausentismo: t.ausentismo, puntualidad: t.puntualidad, extraHoras: Math.round(t.extraTotalMin / 6) / 10, programados: t.programados,
      incapacidadDias: inc.dias, incapacidadCosto: inc.costoSalario };
  });

  // Top 10 de colaboradores con mas novedades (primero las injustificadas).
  const top = new Map();
  for (const a of data.alerts) {
    if (a.shift_date < from || a.shift_date > to) continue;
    const emp = data.employees.get(a.employee_id);
    if (!emp || (area && emp.department !== area)) continue;
    if (!top.has(emp.id)) top.set(emp.id, { employeeId: emp.id, name: emp.name, department: emp.department, total: 0, injustificada: 0, justificada: 0, pendiente: 0 });
    const t = top.get(emp.id);
    t.total++; t[a.mgmt] = (t[a.mgmt] || 0) + 1;
  }
  const topList = [...top.values()].sort((a, b) => b.injustificada - a.injustificada || b.total - a.total || a.name.localeCompare(b.name, 'es')).slice(0, 10);
  const areasAll = [...new Set([...data.employees.values()].map(e => e.department))].sort((a, b) => a.localeCompare(b, 'es'));

  sendJson(res, 200, {
    from, to, area, prevFrom, prevTo, dayZero: data.dayZero,
    total: current.total, areas: current.areas, previous, trend, top: topList, areasAll,
    incapacities: { total: incap.total, previous: incapPrev, employees: incap.employees },
  });
}

// ---------------------------------------------------------------------------
// RESUMEN DIARIO POR CORREO
// ---------------------------------------------------------------------------
const { sendMail } = require('../lib/mailer');
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function dmyISO(iso) { return String(iso || '').split('-').reverse().join('/'); }

function getDigestSettings(orgId) {
  const r = db.prepare('SELECT digest_enabled, digest_hour, digest_to, digest_extra, digest_last_sent FROM org_settings WHERE organization_id = ?').get(orgId) || {};
  return {
    enabled: r.digest_enabled === 1,
    hour: Number.isInteger(r.digest_hour) ? r.digest_hour : 21,
    to: r.digest_to === 'admins_sups' ? 'admins_sups' : 'admins',
    extra: r.digest_extra || '',
    lastSent: r.digest_last_sent || null,
  };
}

function digestRecipients(orgId, settings) {
  const roles = settings.to === 'admins_sups' ? ['org_admin', 'supervisor'] : ['org_admin'];
  const rows = db.prepare(`SELECT DISTINCT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.organization_id = ? AND u.status = 'active' AND r.name IN (${roles.map(() => '?').join(',')})`).all(orgId, ...roles);
  const list = rows.map(r => r.email.toLowerCase());
  for (const e of String(settings.extra || '').split(/[,;\s]+/)) {
    const v = e.trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !list.includes(v)) list.push(v);
  }
  return list;
}

// Arma el resumen del dia (solo cuenta como "no se presento" / "sin cerrar"
// los turnos que ya terminaron a la hora del envio).
function buildDigest(orgId, dateISO, now) {
  const orgName = (db.prepare('SELECT org_name FROM org_settings WHERE organization_id = ?').get(orgId) || {}).org_name || 'tu organización';
  const data = loadIndicatorData(orgId, dateISO, dateISO);
  let programados = 0, asistieron = 0, enCurso = 0, tarde = 0, minTarde = 0;
  const noVinieron = [], sinCerrar = [];
  for (const s of data.shifts) {
    if (s.date !== dateISO) continue;
    const emp = data.employees.get(Number(s.empId));
    if (!emp) continue;
    programados++;
    const d = data.days.get(`${emp.id}|${dateISO}`);
    const ended = bogota.minutesSinceShiftMidnight(now, dateISO) >= clockToRel(s.endTime, s.startTime);
    if (d && d.entrada_real) {
      asistieron++;
      if ((d.retraso_min || 0) > 0) { tarde++; minTarde += d.retraso_min; }
      if (ended && !d.salida_real && d.status !== 'turno_finalizado') sinCerrar.push(emp.name);
    } else if (ended) noVinieron.push(emp.name);
    else enCurso++;
  }
  const manuales = data.alerts.filter(a => a.alert_type === 'marcacion_manual').length;
  const pendientes = db.prepare(`SELECT COUNT(*) AS n FROM attendance_alerts a LEFT JOIN alert_management m ON m.alert_id = a.id
      WHERE a.organization_id = ? AND a.shift_date BETWEEN ? AND ? AND COALESCE(m.status, 'pendiente') = 'pendiente'
        AND a.alert_type IN ('llegada_tarde','exceso_almuerzo','salida_anticipada','inasistencia','turno_sin_cerrar','marcacion_manual')`)
    .get(orgId, bogota.addDaysISO(dateISO, -7), dateISO).n;
  const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const dayName = DAYS[new Date(dateISO + 'T00:00:00Z').getUTCDay()];
  const subject = `Resumen de asistencia – ${dayName} ${dmyISO(dateISO)} – ${orgName}`;
  const names = (arr) => arr.length ? ` (${arr.join(', ')})` : '';
  const lines = [
    ['Programados', String(programados)],
    ['Asistieron', String(asistieron)],
    ['No se presentaron', `${noVinieron.length}${names(noVinieron)}`],
    ['Llegadas tarde', `${tarde}${tarde ? ` (total ${minTarde} min)` : ''}`],
    ['Turnos sin cerrar', `${sinCerrar.length}${names(sinCerrar)}`],
    ['Marcaciones manuales', String(manuales)],
    ...(enCurso ? [['Turnos aún en curso o por iniciar', String(enCurso)]] : []),
    ['Alertas pendientes por gestionar (últimos 7 días)', String(pendientes)],
  ];
  const bodyHtml = `<div style="font-family:Arial,sans-serif;color:#1e293b;max-width:560px">
    <h2 style="margin:0 0 4px;font-size:18px">Resumen de asistencia</h2>
    <p style="margin:0 0 14px;color:#64748b">${escHtml(orgName)} · ${dayName} ${dmyISO(dateISO)}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${lines.map(([k, v]) =>
      `<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;color:#475569">${escHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-weight:bold">${escHtml(v)}</td></tr>`).join('')}</table>
    <p style="margin:14px 0 4px;color:#64748b;font-size:12px">Abre la suite para ver el detalle en Asistencia → Hoy y Alertas:</p></div>`;
  const bodyText = `Resumen de asistencia - ${orgName} - ${dayName} ${dmyISO(dateISO)}\n\n` + lines.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject, bodyHtml, bodyText };
}

async function sendDigest(orgId, recipients, now) {
  const dateISO = bogota.todayISOInBogota(now);
  const msg = buildDigest(orgId, dateISO, now);
  const results = [];
  for (const to of recipients) {
    results.push(await sendMail({ to, subject: msg.subject, link: '/app.html', kind: 'resumen_asistencia', bodyHtml: msg.bodyHtml, bodyText: msg.bodyText }));
  }
  return results;
}

// Revisa cada 5 minutos que organizaciones deben recibir su resumen hoy.
let digestRunning = false;
async function runDigestScheduler() {
  if (digestRunning) return;
  digestRunning = true;
  try {
    const now = new Date();
    const today = bogota.todayISOInBogota(now);
    const hourNow = Math.floor(bogota.minutesSinceShiftMidnight(now, today) / 60);
    const orgs = db.prepare(`SELECT s.organization_id AS id, s.digest_hour FROM org_settings s JOIN organizations o ON o.id = s.organization_id
        WHERE s.digest_enabled = 1 AND o.status = 'active' AND (s.digest_last_sent IS NULL OR s.digest_last_sent < ?)`).all(today);
    for (const o of orgs) {
      if (hourNow < (Number(o.digest_hour) || 0)) continue;
      // Se marca como enviado ANTES de enviar, para no duplicar si hay reinicios.
      db.prepare('UPDATE org_settings SET digest_last_sent = ? WHERE organization_id = ?').run(today, o.id);
      const settings = getDigestSettings(o.id);
      const rec = digestRecipients(o.id, settings);
      if (rec.length) {
        scanMissingMarks(o.id, true);
        await sendDigest(o.id, rec, now);
        console.log(`[asistencia] Resumen diario enviado (${o.id}) a ${rec.length} destinatario(s).`);
      }
    }
  } catch (e) {
    console.error('[asistencia] Resumen diario:', e.message);
  } finally { digestRunning = false; }
}
const digestTimer = setInterval(runDigestScheduler, 5 * 60 * 1000);
if (digestTimer.unref) digestTimer.unref();

// GET /api/attendance/digest-settings
function getDigestSettingsRoute(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const s = getDigestSettings(orgId);
  sendJson(res, 200, { ...s, recipients: digestRecipients(orgId, s) });
}

// PUT /api/attendance/digest-settings  { enabled, hour, to, extra }
async function saveDigestSettings(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const hour = Number(body.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return sendJson(res, 400, { error: 'La hora de envío no es válida.' });
  const to = body.to === 'admins_sups' ? 'admins_sups' : 'admins';
  const extraList = String(body.extra || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  const bad = extraList.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad.length) return sendJson(res, 400, { error: `Correo no válido: ${bad[0]}` });
  if (extraList.length > 10) return sendJson(res, 400, { error: 'Máximo 10 correos adicionales.' });
  const extra = extraList.join(', ');
  const enabled = body.enabled ? 1 : 0;
  const prev = getDigestSettings(orgId);
  const exists = db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId);
  if (!exists) db.prepare("INSERT INTO org_settings (organization_id, org_name) VALUES (?, 'Empresa')").run(orgId);
  db.prepare('UPDATE org_settings SET digest_enabled = ?, digest_hour = ?, digest_to = ?, digest_extra = ? WHERE organization_id = ?')
    .run(enabled, hour, to, extra || null, orgId);
  logAction({
    organizationId: orgId, userId: req.user.id, action: 'attendance.digest_settings', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req),
    metadata: { activo: !!enabled, activoAntes: prev.enabled, hora: hour, destinatarios: to === 'admins_sups' ? 'Administradores y supervisores' : 'Administradores', adicionales: extra || null },
  });
  const s = getDigestSettings(orgId);
  sendJson(res, 200, { ok: true, ...s, recipients: digestRecipients(orgId, s) });
}

// POST /api/attendance/digest-test -- envia el resumen de hoy SOLO al usuario que lo pide.
async function sendDigestTest(req, res) {
  const orgId = resolveOrgId(req, {});
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  if (!u || !u.email) return sendJson(res, 400, { error: 'Tu usuario no tiene correo.' });
  scanMissingMarks(orgId, true);
  const [r] = await sendDigest(orgId, [u.email], new Date());
  sendJson(res, 200, { ok: true, to: u.email, delivered: !!(r && r.delivered), mode: r ? r.mode : null });
}

// ===========================================================================
// SALUD DE LOS DISPOSITIVOS (kioscos): senal "estoy vivo", estado y avisos.
// ===========================================================================
const KIOSK_ONLINE_MS = 150 * 1000; // hasta 2,5 min sin senal = en linea (la senal llega cada minuto)
const CAMERA_STATES = ['ok', 'denegada', 'sin_camara', 'error', 'desconocido'];

function getDeviceAlertSettings(orgId) {
  const r = db.prepare('SELECT device_alerts_enabled, device_offline_min FROM org_settings WHERE organization_id = ?').get(orgId) || {};
  const min = Number(r.device_offline_min);
  return { offlineMin: Number.isInteger(min) && min >= 3 ? min : 10 };
}

function logDeviceEvent(orgId, deviceId, type, details) {
  db.prepare("INSERT INTO device_events (id, organization_id, device_id, event_type, details, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-5 hours'))")
    .run(uid('dev_ev'), orgId, deviceId, type, details || null);
}

// Estado calculado de un dispositivo a partir de su ultima senal.
function deviceHealth(d, nowMs = Date.now()) {
  if (!d.hb_at_ms) return { status: 'sin_datos', label: 'Sin datos de salud', lastSeenMin: null };
  const settings = getDeviceAlertSettings(d.organization_id);
  const ageMs = nowMs - Number(d.hb_at_ms);
  const lastSeenMin = Math.max(0, Math.floor(ageMs / 60000));
  let status = 'en_linea';
  if (ageMs > settings.offlineMin * 60000) status = 'sin_conexion';
  else if (ageMs > KIOSK_ONLINE_MS) status = 'intermitente';
  const warnings = [];
  if (d.hb_battery != null && d.hb_battery < 0.2 && !d.hb_charging) warnings.push('bateria_baja');
  if (d.hb_camera && d.hb_camera !== 'ok' && d.hb_camera !== 'desconocido') warnings.push('camara');
  if ((d.hb_pending || 0) > 0) warnings.push('pendientes');
  return {
    status, lastSeenMin, lastSeenAt: new Date(Number(d.hb_at_ms) - 5 * 3600000).toISOString().slice(0, 16).replace('T', ' '),
    battery: d.hb_battery == null ? null : Math.round(d.hb_battery * 100), charging: d.hb_charging == null ? null : !!d.hb_charging,
    camera: d.hb_camera || 'desconocido', pending: d.hb_pending || 0, version: d.hb_version || null,
    offlineSinceMin: d.offline_since_ms ? Math.floor((nowMs - Number(d.offline_since_ms)) / 60000) : null,
    warnings, offlineThresholdMin: settings.offlineMin,
  };
}

// POST /api/kiosk/heartbeat  { battery: {level, charging}, camera, pending, version }
async function kioskHeartbeat(req, res) {
  const device = authenticateDevice(req, res, false);
  if (!device) return;
  let body = {};
  try { body = await readBody(req, 16 * 1024); } catch { /* senal sin datos */ }
  const nowMs = Date.now();
  const bat = body.battery && Number.isFinite(Number(body.battery.level)) ? Math.max(0, Math.min(1, Number(body.battery.level))) : null;
  const charging = body.battery && body.battery.charging != null ? (body.battery.charging ? 1 : 0) : null;
  const camera = CAMERA_STATES.includes(body.camera) ? body.camera : 'desconocido';
  const pending = Number.isInteger(Number(body.pending)) ? Math.max(0, Number(body.pending)) : 0;
  const version = String(body.version || '').slice(0, 30) || null;
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);

  // Reconexion despues de estar "sin conexion".
  if (device.offline_since_ms) {
    const mins = Math.round((nowMs - Number(device.offline_since_ms)) / 60000);
    logDeviceEvent(device.organization_id, device.id, 'reconectado', `Volvió a conectarse después de ${mins} min sin señal${pending ? ` · ${pending} marcación(es) pendiente(s) por enviar` : ''}.`);
  }
  // Camara: se registra el cambio de estado (no en cada senal).
  if (camera !== 'desconocido' && camera !== (device.hb_camera || 'desconocido')) {
    if (camera !== 'ok') logDeviceEvent(device.organization_id, device.id, 'camara', camera === 'denegada' ? 'El navegador no tiene permiso para usar la cámara.' : camera === 'sin_camara' ? 'No se detecta ninguna cámara en el equipo.' : 'La cámara presentó un error al iniciar.');
    else if (device.hb_camera && device.hb_camera !== 'desconocido') logDeviceEvent(device.organization_id, device.id, 'camara_ok', 'La cámara volvió a funcionar.');
  }
  // Bateria baja (menos del 20 % y desconectada): un aviso por dia.
  const today = bogota.todayISOInBogota();
  let batteryNotified = device.battery_notified_date;
  if (bat != null && bat < 0.2 && charging === 0 && device.battery_notified_date !== today) {
    batteryNotified = today;
    logDeviceEvent(device.organization_id, device.id, 'bateria_baja', `Batería al ${Math.round(bat * 100)} % y sin cargar.`);
  }
  db.prepare(`UPDATE attendance_devices SET hb_at_ms = ?, hb_battery = ?, hb_charging = ?, hb_camera = ?, hb_pending = ?, hb_version = ?, hb_ua = ?,
      hb_online_since_ms = CASE WHEN offline_since_ms IS NOT NULL OR hb_online_since_ms IS NULL THEN ? ELSE hb_online_since_ms END,
      offline_since_ms = NULL, offline_notified = 0, battery_notified_date = ? WHERE id = ?`)
    .run(nowMs, bat, charging, camera, pending, version, ua, nowMs, batteryNotified, device.id);
  sendJson(res, 200, { ok: true, serverTime: new Date(nowMs).toISOString() });
}

// Revisa cada minuto los kioscos que dejaron de enviar senal.
let deviceMonitorRunning = false;
async function runDeviceMonitor() {
  if (deviceMonitorRunning) return;
  deviceMonitorRunning = true;
  try {
    const nowMs = Date.now();
    const devices = db.prepare('SELECT * FROM attendance_devices WHERE active = 1 AND hb_at_ms IS NOT NULL').all();
    for (const d of devices) {
      const settings = getDeviceAlertSettings(d.organization_id);
      if (nowMs - Number(d.hb_at_ms) <= settings.offlineMin * 60000) continue;
      if (!d.offline_since_ms) {
        db.prepare('UPDATE attendance_devices SET offline_since_ms = ? WHERE id = ?').run(Number(d.hb_at_ms), d.id);
        d.offline_since_ms = Number(d.hb_at_ms);
        logDeviceEvent(d.organization_id, d.id, 'sin_conexion', `Dejó de enviar señal (más de ${settings.offlineMin} min sin conexión).`);
      }
      // (Sin avisos por correo: el estado se ve en Dispositivos y en el tablero Hoy.)
    }
  } catch (e) {
    console.error('[asistencia] Monitor de dispositivos:', e.message);
  } finally { deviceMonitorRunning = false; }
}
const deviceTimer = setInterval(runDeviceMonitor, 60 * 1000);
if (deviceTimer.unref) deviceTimer.unref();

// GET /api/attendance/devices/:id/events
function listDeviceEvents(req, res, params, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const device = db.prepare('SELECT * FROM attendance_devices WHERE id = ? AND organization_id = ?').get(params.id, orgId);
  if (!device) return sendJson(res, 404, { error: 'Dispositivo no encontrado en esta organizacion.' });
  const rows = db.prepare('SELECT event_type, details, created_at FROM device_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 60').all(device.id);
  sendJson(res, 200, { device: deviceOutputRow(device), userAgent: device.hb_ua || null, events: rows });
}

// GET / PUT /api/attendance/device-alert-settings  { offlineMin }
function getDeviceAlertSettingsRoute(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  sendJson(res, 200, getDeviceAlertSettings(orgId));
}
async function saveDeviceAlertSettings(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const min = Number(body.offlineMin);
  if (!Number.isInteger(min) || min < 3 || min > 240) return sendJson(res, 400, { error: 'Los minutos sin señal deben estar entre 3 y 240.' });
  if (!db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId)) db.prepare("INSERT INTO org_settings (organization_id, org_name) VALUES (?, 'Empresa')").run(orgId);
  db.prepare('UPDATE org_settings SET device_offline_min = ? WHERE organization_id = ?').run(min, orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'attendance.device_alert_settings', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req),
    metadata: { minutos: min } });
  sendJson(res, 200, { ok: true, ...getDeviceAlertSettings(orgId) });
}

// Dispositivos con problemas (para el tablero "Hoy").
function devicesWithProblems(orgId) {
  const nowMs = Date.now();
  return db.prepare(`SELECT d.* FROM attendance_devices d WHERE d.organization_id = ? AND d.active = 1
      AND EXISTS (SELECT 1 FROM attendance_device_employees de WHERE de.device_id = d.id)`).all(orgId)
    .map(d => ({ id: d.id, name: d.device_name, health: deviceHealth(d, nowMs) }))
    .filter(d => d.health.status === 'sin_conexion' || d.health.status === 'intermitente' || d.health.warnings.length);
}

// Recalculo unico de los dias ya cerrados cada vez que cambia una regla del
// motor de horas. Cada version se registra en app_migrations para que se
// ejecute UNA sola vez, aunque el servicio se reinicie.
const HOURS_ENGINE_VERSION = 'horas_v3_recargo_por_colaborador';
db.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
if (!db.prepare('SELECT 1 FROM app_migrations WHERE name = ?').get(HOURS_ENGINE_VERSION)) {
  try {
    const n = recalculateFinalizedDays();
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)').run(HOURS_ENGINE_VERSION);
    console.log(`[asistencia] Recalculo de horas (${HOURS_ENGINE_VERSION}) aplicado a ${n} dia(s) cerrado(s).`);
  } catch (e) {
    console.error('[asistencia] No se pudo recalcular los dias cerrados:', e.message);
  }
}

module.exports = {
  recalculateFinalizedDays,
  listEmployeesToday, registerMark, listHistory, listMyHistory, listAlerts, registerCorrection, listCorrections, listFaceProfiles, enrollFaceProfile, deactivateFaceProfile, registerMarkByFace,
  listDevices, createDevice, rotateDeviceToken, deactivateDevice, getDeviceAssignments, setDeviceAssignments,
  kioskEmployeesToday, kioskMark, kioskMarkByFace,
  listPayrollAttendance,
  todayBoard, manageAlert, getAlertAttachment, novedadesSummary,
  indicators, getDigestSettingsRoute, saveDigestSettings, sendDigestTest,
  kioskHeartbeat, listDeviceEvents, getDeviceAlertSettingsRoute, saveDeviceAlertSettings,
};
