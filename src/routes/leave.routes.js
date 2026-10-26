'use strict';
// ---------------------------------------------------------------------------
// DESCANSOS ACUMULADOS (contrato a termino fijo e indefinido)
//
//  - Se GANA +1 descanso por cada semana (lunes a domingo, ya terminada) en la
//    que el colaborador trabajo los 7 dias (los 7 con marcacion de entrada).
//  - Se USA asignando en el cuadro de turnos la inasistencia "Descanso
//    acumulado": cada dia descuenta 1. (El "Compensatorio" NO se toca: ese se da
//    a cambio de horas extras a favor.)
//  - Saldo inicial (una vez) y ajustes manuales con motivo.
//  - El saldo NO se guarda como un numero suelto: se calcula siempre desde las
//    marcaciones y el cuadro de turnos. Si se quita un Descanso acumulado del cuadro,
//    el dia vuelve solo al saldo.
//  - Cuenta desde el dia siguiente al Dia 0 de la organizacion (o desde que se
//    activo esta funcion, si no hay Dia 0). Lo anterior va en el saldo inicial.
// ---------------------------------------------------------------------------
const { db, uid } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const live = require('../lib/live');
const { todayISOInBogota, addDaysISO } = require('../lib/bogota-time');

db.exec(`
CREATE TABLE IF NOT EXISTS rest_day_moves (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  move_date TEXT NOT NULL,
  qty INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('inicial','ajuste')),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
);
CREATE INDEX IF NOT EXISTS idx_rest_day_moves_emp ON rest_day_moves(organization_id, employee_id);
`);
const setCols = db.prepare('PRAGMA table_info(org_settings)').all().map(c => c.name);
if (!setCols.includes('rest_days_since')) db.exec('ALTER TABLE org_settings ADD COLUMN rest_days_since TEXT NULL');

const ELIGIBLE = new Set(['indefinido', 'fijo']);

function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}

// Desde cuando se cuentan los descansos: dia siguiente al Dia 0; si no hay
// Dia 0, el dia en que se activo la funcion (se guarda la primera vez).
function restSince(orgId) {
  const r = db.prepare('SELECT day_zero, rest_days_since FROM org_settings WHERE organization_id = ?').get(orgId);
  if (r && r.day_zero) return addDaysISO(r.day_zero, 1);
  if (r && r.rest_days_since) return r.rest_days_since;
  const today = todayISOInBogota();
  db.prepare('UPDATE org_settings SET rest_days_since = ? WHERE organization_id = ?').run(today, orgId);
  return today;
}

// Inasistencia "Descanso acumulado": id fijo para todas las organizaciones (asi,
// si alguien la borra, al recrearla los dias ya asignados siguen contando).
// No cuenta como ausentismo.
const REST_KEY = 'abs_descanso_acumulado';
function ensureRestAbsence(orgId) {
  const row = db.prepare('SELECT id, data_json FROM shift_presets WHERE organization_id = ? AND data_json LIKE ?').get(orgId, `%"id":"${REST_KEY}"%`);
  if (row) {
    let p; try { p = JSON.parse(row.data_json); } catch { p = null; }
    if (p && p.hidden) { p.hidden = false; db.prepare('UPDATE shift_presets SET data_json = ? WHERE id = ?').run(JSON.stringify(p), row.id); return true; }
    return false;
  }
  db.prepare('INSERT INTO shift_presets (id, organization_id, data_json) VALUES (?, ?, ?)')
    .run(uid('psr'), orgId, JSON.stringify({ id: REST_KEY, kind: 'absence', name: 'Descanso acumulado', color: 'cyan', countsAbsence: false }));
  return true;
}
// Al arrancar: todas las organizaciones tienen la inasistencia.
try { for (const o of db.prepare('SELECT id FROM organizations').all()) ensureRestAbsence(o.id); } catch (e) { console.error('[descansos]', e.message); }

function weekdayISO(dateISO) { return new Date(dateISO + 'T00:00:00Z').getUTCDay(); } // 0 = domingo
function mondayOnOrAfter(dateISO) {
  const wd = weekdayISO(dateISO);
  return addDaysISO(dateISO, wd === 1 ? 0 : (8 - wd) % 7);
}

function computeRestDays(orgId) {
  const since = restSince(orgId);
  const today = todayISOInBogota();
  // Si la inasistencia no existe (organizacion nueva o la borraron), se crea y
  // se avisa a las pestanas abiertas para que la carguen.
  if (ensureRestAbsence(orgId)) { try { live.publish(orgId, { scopes: ['data'], kind: 'rest-absence' }); } catch { /* nada */ } }
  const restKey = REST_KEY;
  const employees = db.prepare(`SELECT id, name, department, contract_type FROM employees
    WHERE organization_id = ? AND COALESCE(status, 'activo') != 'retirado' ORDER BY name`).all(orgId)
    .filter(e => ELIGIBLE.has(e.contract_type || 'indefinido'));
  const ids = new Set(employees.map(e => Number(e.id)));

  // Dias trabajados (con marcacion de entrada) desde la fecha de inicio.
  const worked = new Map();
  for (const d of db.prepare('SELECT employee_id, shift_date FROM attendance_days WHERE organization_id = ? AND shift_date >= ? AND shift_date < ? AND entrada_real IS NOT NULL')
    .all(orgId, since, today)) {
    if (!ids.has(Number(d.employee_id))) continue;
    if (!worked.has(d.employee_id)) worked.set(d.employee_id, new Set());
    worked.get(d.employee_id).add(d.shift_date);
  }
  // Semanas completas ya terminadas (lunes a domingo) desde la fecha de inicio.
  const weeks = [];
  for (let mon = mondayOnOrAfter(since); addDaysISO(mon, 6) < today; mon = addDaysISO(mon, 7)) weeks.push(mon);

  // Dias de "Descanso acumulado" en el cuadro de turnos.
  const used = new Map();
  {
    for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ? AND data_json LIKE ?').all(orgId, `%"absenceType":"${restKey}"%`)) {
      let s; try { s = JSON.parse(r.data_json); } catch { continue; }
      if (!s || s.absenceType !== restKey || !s.date || s.date < since || !ids.has(Number(s.empId))) continue;
      const k = Number(s.empId);
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(s.date);
    }
  }
  // Saldo inicial y ajustes.
  const moves = new Map();
  for (const m of db.prepare(`SELECT m.*, u.email AS by_email FROM rest_day_moves m LEFT JOIN users u ON u.id = m.created_by
    WHERE m.organization_id = ? ORDER BY m.move_date, m.created_at`).all(orgId)) {
    const k = Number(m.employee_id);
    if (!moves.has(k)) moves.set(k, []);
    moves.get(k).push({ id: m.id, date: m.move_date, qty: m.qty, kind: m.kind, note: m.note || '', by: m.by_email || '', at: m.created_at });
  }

  return {
    since, today, restKey,
    employees: employees.map(e => {
      const id = Number(e.id);
      const w = worked.get(e.id) || worked.get(id) || new Set();
      const earnedWeeks = weeks.filter(mon => { for (let i = 0; i < 7; i++) if (!w.has(addDaysISO(mon, i))) return false; return true; });
      const usedDates = [...(used.get(id) || [])].sort();
      const mv = moves.get(id) || [];
      const initial = mv.filter(m => m.kind === 'inicial').reduce((a, m) => a + m.qty, 0);
      const adjust = mv.filter(m => m.kind === 'ajuste').reduce((a, m) => a + m.qty, 0);
      return {
        id, name: e.name, department: e.department || '', contractType: e.contract_type || 'indefinido',
        initial, earned: earnedWeeks.length, used: usedDates.length, adjust,
        balance: initial + earnedWeeks.length + adjust - usedDates.length,
        earnedWeeks, usedDates, moves: mv,
      };
    }),
  };
}

// GET /api/rest-days
function listRestDays(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  sendJson(res, 200, computeRestDays(orgId));
}

// POST /api/rest-days/moves { employeeId, kind: 'inicial'|'ajuste', qty, note }
async function addRestDayMove(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare('SELECT id, name, contract_type, status FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  if (!ELIGIBLE.has(emp.contract_type || 'indefinido')) return sendJson(res, 400, { error: 'Los descansos acumulados son solo para contratos a término fijo o indefinido.' });
  const kind = body.kind === 'inicial' ? 'inicial' : 'ajuste';
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 60) return sendJson(res, 400, { error: 'La cantidad debe ser un número entero entre -60 y 60 (sin 0).' });
  if (kind === 'inicial' && qty < 0) return sendJson(res, 400, { error: 'El saldo inicial no puede ser negativo.' });
  const note = String(body.note || '').trim().slice(0, 300);
  if (kind === 'ajuste' && note.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo del ajuste (mínimo 5 caracteres).' });
  if (kind === 'inicial' && db.prepare("SELECT 1 FROM rest_day_moves WHERE organization_id = ? AND employee_id = ? AND kind = 'inicial'").get(orgId, emp.id)) {
    return sendJson(res, 409, { error: `${emp.name} ya tiene saldo inicial. Para corregirlo, haz un ajuste.` });
  }
  const since = restSince(orgId);
  const date = kind === 'inicial' ? addDaysISO(since, -1) : todayISOInBogota();
  const id = uid('rest');
  db.prepare('INSERT INTO rest_day_moves (id, organization_id, employee_id, move_date, qty, kind, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, emp.id, date, qty, kind, note || null, req.user.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'rest_days.move', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, tipo: kind, cantidad: qty, motivo: note || null } });
  sendJson(res, 200, { ok: true, id });
}

// ---------------------------------------------------------------------------
// VACACIONES (contrato a termino indefinido y fijo)
//
//  - 15 dias HABILES por cada año de servicio, causados dia a dia en proporcion
//    (15 por cada 360 dias, año comercial: 1,25 dias por mes).
//  - Se cuentan desde la FECHA DE INGRESO (se registra aqui; en termino fijo, si
//    no se registra, se usa el inicio del contrato). Si el contrato fijo termino,
//    se liquido y se firmo uno nuevo, se registra "contrato nuevo" y el conteo
//    se reinicia. Una prorroga NO reinicia el conteo.
//  - Saldo inicial: dias disponibles al Dia 0 (lo anterior a la suite). Si hay
//    saldo inicial, se causa desde el dia siguiente al Dia 0.
//  - Se USAN asignando "Vacaciones" en el cuadro de turnos. Solo descuentan los
//    dias habiles: lunes a sabado que no sean festivo (domingos y festivos no).
//  - Como los descansos, el saldo se calcula siempre desde el cuadro de turnos.
// ---------------------------------------------------------------------------
const { isHolidayCO } = require('../lib/holidays-co');
db.exec(`
CREATE TABLE IF NOT EXISTS vacation_moves (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  move_date TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK(kind IN ('ingreso','inicial','ajuste','reinicio')),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
);
CREATE INDEX IF NOT EXISTS idx_vacation_moves_emp ON vacation_moves(organization_id, employee_id);
`);
// Saldo inicial con desglose (oct 2026): periodos anteriores (manual) + dias
// causados en un periodo que la suite calcula sola (desde / hasta) - dias ya
// disfrutados por fuera de la suite. Un saldo inicial se puede rehacer: el
// anterior queda anulado (voided_at) y no cuenta.
{
  const vc = db.prepare('PRAGMA table_info(vacation_moves)').all().map(c => c.name);
  for (const [c, t] of [['prev_days', 'REAL'], ['calc_from', 'TEXT'], ['calc_to', 'TEXT'], ['calc_days', 'REAL'], ['taken_before', 'REAL'], ['voided_at', 'TEXT'], ['voided_by', 'TEXT']]) {
    if (!vc.includes(c)) db.exec(`ALTER TABLE vacation_moves ADD COLUMN ${c} ${t}`);
  }
}
const VAC_KEY = 'vacaciones';
const VAC_PER_YEAR = 15;
// Las Vacaciones del cuadro de turnos se descuentan solo desde el dia en que se
// activo el control de vacaciones en la suite (23/10/2026). Lo anterior se
// registra en el saldo inicial ("ya disfrutados").
const VAC_ROSTER_FROM = '2026-10-23';
function isBusinessDayCO(dateISO) { return weekdayISO(dateISO) !== 0 && !isHolidayCO(dateISO); }
// Dias entre dos fechas en año comercial de 360 dias (meses de 30), contando
// ambos extremos: del 1 de enero al 31 de diciembre = 360.
function days360(fromISO, toISO) {
  if (!fromISO || !toISO || toISO < fromISO) return 0;
  const [y1, m1, d1r] = fromISO.split('-').map(Number), [y2, m2, d2r] = toISO.split('-').map(Number);
  const d1 = Math.min(d1r, 30), d2 = Math.min(d2r, 30);
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1) + 1;
}
const round2 = (n) => Math.round(n * 100) / 100;

function computeVacations(orgId) {
  const since = restSince(orgId);
  const today = todayISOInBogota();
  const employees = db.prepare(`SELECT id, name, department, contract_type, contract_start FROM employees
    WHERE organization_id = ? AND COALESCE(status, 'activo') != 'retirado' ORDER BY name`).all(orgId)
    .filter(e => ELIGIBLE.has(e.contract_type || 'indefinido'));
  const ids = new Set(employees.map(e => Number(e.id)));
  // Dias de Vacaciones en el cuadro de turnos.
  const vac = new Map();
  for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ? AND data_json LIKE ?').all(orgId, `%"absenceType":"${VAC_KEY}"%`)) {
    let s; try { s = JSON.parse(r.data_json); } catch { continue; }
    if (!s || s.absenceType !== VAC_KEY || !s.date || !ids.has(Number(s.empId))) continue;
    const k = Number(s.empId);
    if (!vac.has(k)) vac.set(k, new Set());
    vac.get(k).add(s.date);
  }
  const moves = new Map();
  for (const m of db.prepare(`SELECT m.*, u.email AS by_email FROM vacation_moves m LEFT JOIN users u ON u.id = m.created_by
    WHERE m.organization_id = ? AND m.voided_at IS NULL ORDER BY m.created_at`).all(orgId)) {
    const k = Number(m.employee_id);
    if (!moves.has(k)) moves.set(k, []);
    moves.get(k).push({ id: m.id, date: m.move_date, qty: m.qty, kind: m.kind, note: m.note || '', by: m.by_email || '', at: m.created_at,
      prev: m.prev_days, calcFrom: m.calc_from || null, calcTo: m.calc_to || null, calcDays: m.calc_days, takenBefore: m.taken_before });
  }
  const thisMonth = today.slice(5, 7);
  return {
    since, today, vacKey: VAC_KEY, perYear: VAC_PER_YEAR, rosterFrom: VAC_ROSTER_FROM,
    employees: employees.map(e => {
      const id = Number(e.id);
      const mv = moves.get(id) || [];
      const ingresoMv = mv.filter(m => m.kind === 'ingreso').pop();
      const hireDate = ingresoMv ? ingresoMv.date : (e.contract_type === 'fijo' && e.contract_start ? e.contract_start : null);
      const reinicio = mv.filter(m => m.kind === 'reinicio').sort((a, b) => a.date.localeCompare(b.date)).pop() || null;
      // Fecha desde la que se causan las vacaciones de la relacion actual.
      const start = reinicio && (!hireDate || reinicio.date > hireDate) ? reinicio.date : hireDate;
      // El saldo inicial y los ajustes anteriores a un "contrato nuevo" ya no cuentan.
      const current = mv.filter(m => !reinicio || m.created_at >= reinicio.at || m === reinicio);
      const inicialMv = current.find(m => m.kind === 'inicial') || null;
      const initial = inicialMv ? inicialMv.qty : 0;
      const adjust = round2(current.filter(m => m.kind === 'ajuste').reduce((a, m) => a + m.qty, 0));
      // Causacion: con saldo inicial calculado (desde/hasta), desde el dia
      // siguiente al "hasta" y las vacaciones del cuadro desde el "desde"; con un
      // saldo inicial del formato anterior, desde el dia siguiente al Dia 0; sin
      // saldo inicial, desde la fecha de ingreso (o el contrato nuevo).
      let accrualFrom = start, usageFrom = start || since;
      if (inicialMv && inicialMv.calcTo) {
        accrualFrom = addDaysISO(inicialMv.calcTo, 1);
        usageFrom = inicialMv.calcFrom || accrualFrom;
      } else if (start && inicialMv && since > start) { accrualFrom = since; usageFrom = since; }
      const accrued = (start || (inicialMv && inicialMv.calcTo)) ? round2(days360(accrualFrom, today) * VAC_PER_YEAR / 360) : 0;
      if (usageFrom < VAC_ROSTER_FROM) usageFrom = VAC_ROSTER_FROM;
      const allVac = [...(vac.get(id) || [])].filter(d => d >= VAC_ROSTER_FROM).sort();
      // Las Vacaciones del cuadro solo se descuentan cuando el colaborador ya tiene
      // su saldo inicial registrado (asi una empresa puede no usar la funcion, o
      // organizar primero los saldos, sin que se desordene nada).
      const tracking = !!inicialMv;
      const pendingRosterDays = tracking ? 0 : allVac.filter(d => d >= usageFrom).filter(isBusinessDayCO).length;
      const days = tracking ? allVac.filter(d => d >= usageFrom) : [];
      const business = days.filter(isBusinessDayCO);
      const taken = business.filter(d => d <= today).length;
      const scheduled = business.filter(d => d > today).length;
      const available = round2(initial + accrued + adjust - taken - scheduled);
      const years = start ? Math.floor(days360(start, today) / 360) : 0;
      return {
        id, name: e.name, department: e.department || '', contractType: e.contract_type || 'indefinido',
        hireDate, start, usageFrom, accrualFrom, initialLegacy: !!(inicialMv && !inicialMv.calcTo && inicialMv.prev == null),
        initialMove: inicialMv, tracking, pendingRosterDays, rosterBusinessDays: allVac.filter(isBusinessDayCO), restarted: !!(reinicio && start === reinicio.date), needsInitial: !!(start && start < since && !inicialMv),
        initial, accrued, adjust, taken, scheduled, available, years,
        anniversaryThisMonth: !!(start && years >= 0 && start.slice(5, 7) === thisMonth && start.slice(0, 4) < today.slice(0, 4)),
        twoPeriods: available >= 2 * VAC_PER_YEAR,
        vacationDays: days, businessDays: business, moves: current,
      };
    }),
  };
}

// GET /api/vacations
function listVacations(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  sendJson(res, 200, computeVacations(orgId));
}

// POST /api/vacations/moves { employeeId, kind: 'ingreso'|'inicial'|'ajuste'|'reinicio', date?, qty?, note? }
async function addVacationMove(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare('SELECT id, name, contract_type FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  if (!ELIGIBLE.has(emp.contract_type || 'indefinido')) return sendJson(res, 400, { error: 'Las vacaciones se llevan solo para contratos a término fijo o indefinido.' });
  const kind = ['ingreso', 'inicial', 'ajuste', 'reinicio'].includes(body.kind) ? body.kind : null;
  if (!kind) return sendJson(res, 400, { error: 'Tipo de movimiento no valido.' });
  const today = todayISOInBogota();
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null;
  const note = String(body.note || '').trim().slice(0, 300);
  let date = today, qty = 0;
  if (kind === 'ingreso' || kind === 'reinicio') {
    date = okDate(body.date);
    if (!date) return sendJson(res, 400, { error: 'Indica la fecha.' });
    if (date > today) return sendJson(res, 400, { error: 'La fecha no puede ser futura.' });
  } else {
    qty = Math.round(Number(body.qty) * 2) / 2; // de a medio dia
    if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 120) return sendJson(res, 400, { error: 'La cantidad debe estar entre -120 y 120 días (sin 0; se permite medio día).' });
    if (kind === 'inicial' && qty < 0) return sendJson(res, 400, { error: 'El saldo inicial no puede ser negativo.' });
    if (kind === 'ajuste' && note.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo del ajuste (mínimo 5 caracteres).' });
    if (kind === 'inicial') {
      const st = computeVacations(orgId).employees.find(x => x.id === Number(emp.id));
      if (st && st.moves.some(m => m.kind === 'inicial')) return sendJson(res, 409, { error: `${emp.name} ya tiene saldo inicial. Para corregirlo, haz un ajuste.` });
      date = addDaysISO(restSince(orgId), -1);
    }
  }
  const id = uid('vac');
  db.prepare('INSERT INTO vacation_moves (id, organization_id, employee_id, move_date, qty, kind, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, emp.id, date, qty, kind, note || null, req.user.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'vacations.move', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, tipo: kind, cantidad: qty || null, fecha: date, motivo: note || null } });
  sendJson(res, 200, { ok: true, id });
}

// POST /api/vacations/initial { employeeId, prevDays, calcFrom?, calcTo?, takenBefore?, note? }
// Registra (o rehace) el saldo inicial: periodos anteriores + dias causados
// del periodo desde/hasta (calculados por la suite) - dias ya disfrutados por
// fuera de la suite. Si ya habia un saldo inicial, queda anulado.
function vacInitialCalcDays(from, to) { return round2(days360(from, to) * VAC_PER_YEAR / 360); }
async function saveVacationInitial(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emp = db.prepare('SELECT id, name, contract_type FROM employees WHERE id = ? AND organization_id = ?').get(Number(body.employeeId), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  if (!ELIGIBLE.has(emp.contract_type || 'indefinido')) return sendJson(res, 400, { error: 'Las vacaciones se llevan solo para contratos a término fijo o indefinido.' });
  const today = todayISOInBogota();
  const half = (v) => Math.round(Number(v || 0) * 2) / 2;
  const prev = half(body.prevDays), taken = half(body.takenBefore);
  if (!Number.isFinite(prev) || prev < 0 || prev > 150) return sendJson(res, 400, { error: 'Los días de periodos anteriores deben estar entre 0 y 150.' });
  if (!Number.isFinite(taken) || taken < 0 || taken > 150) return sendJson(res, 400, { error: 'Los días ya disfrutados deben estar entre 0 y 150.' });
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null;
  const from = okDate(body.calcFrom), to = okDate(body.calcTo);
  if ((body.calcFrom || body.calcTo) && (!from || !to)) return sendJson(res, 400, { error: 'Indica las dos fechas del periodo a calcular (desde y hasta).' });
  if (from && from > to) return sendJson(res, 400, { error: 'La fecha "desde" no puede ser posterior a la fecha "hasta".' });
  if (to && to > today) return sendJson(res, 400, { error: 'La fecha "hasta" no puede ser futura.' });
  const st = computeVacations(orgId).employees.find(x => x.id === Number(emp.id));
  if (from && st && st.start && from < st.start) return sendJson(res, 400, { error: `La fecha "desde" no puede ser anterior al ingreso (${st.start.split('-').reverse().join('/')}).` });
  if (!from && prev === 0) return sendJson(res, 400, { error: 'Escribe los días de periodos anteriores o indica el periodo a calcular.' });
  const calcDays = from ? vacInitialCalcDays(from, to) : 0;
  const qty = round2(prev + calcDays - taken);
  const note = String(body.note || '').trim().slice(0, 300);
  const before = st && st.initialMove ? st.initialMove : null;
  const id = uid('vac');
  db.exec('BEGIN');
  try {
    if (before) db.prepare("UPDATE vacation_moves SET voided_at = datetime('now', '-5 hours'), voided_by = ? WHERE id = ? AND organization_id = ?").run(req.user.id, before.id, orgId);
    db.prepare(`INSERT INTO vacation_moves (id, organization_id, employee_id, move_date, qty, kind, note, created_by, prev_days, calc_from, calc_to, calc_days, taken_before)
                VALUES (?, ?, ?, ?, ?, 'inicial', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, emp.id, to || addDaysISO(restSince(orgId), -1), qty, note || null, req.user.id, prev, from, to, calcDays, taken);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'vacations.initial', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, total: qty, anteriores: prev, desde: from, hasta: to, causados: calcDays, disfrutados: taken, motivo: note || null,
      antes: before ? { total: before.qty, anteriores: before.prev, desde: before.calcFrom, hasta: before.calcTo, causados: before.calcDays, disfrutados: before.takenBefore } : null } });
  sendJson(res, 200, { ok: true, id, total: qty, calcDays });
}

module.exports = { listRestDays, addRestDayMove, computeRestDays, listVacations, addVacationMove, computeVacations, saveVacationInitial };
