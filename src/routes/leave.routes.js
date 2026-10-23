'use strict';
// ---------------------------------------------------------------------------
// DESCANSOS ACUMULADOS (contrato a termino fijo e indefinido)
//
//  - Se GANA +1 descanso por cada semana (lunes a domingo, ya terminada) en la
//    que el colaborador trabajo los 7 dias (los 7 con marcacion de entrada).
//  - Se USA asignando en el cuadro de turnos la inasistencia "Compensatorio":
//    cada dia descuenta 1.
//  - Saldo inicial (una vez) y ajustes manuales con motivo.
//  - El saldo NO se guarda como un numero suelto: se calcula siempre desde las
//    marcaciones y el cuadro de turnos. Si se quita un Compensatorio del cuadro,
//    el dia vuelve solo al saldo.
//  - Cuenta desde el dia siguiente al Dia 0 de la organizacion (o desde que se
//    activo esta funcion, si no hay Dia 0). Lo anterior va en el saldo inicial.
// ---------------------------------------------------------------------------
const { db, uid } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
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

// Id de la inasistencia "Compensatorio" de la organizacion (o null).
function compensatorioKey(orgId) {
  for (const r of db.prepare('SELECT data_json FROM shift_presets WHERE organization_id = ?').all(orgId)) {
    let p; try { p = JSON.parse(r.data_json); } catch { continue; }
    if (p && p.kind === 'absence' && !p.hidden && String(p.name || '').trim().toLowerCase() === 'compensatorio') return p.id;
  }
  return null;
}

function weekdayISO(dateISO) { return new Date(dateISO + 'T00:00:00Z').getUTCDay(); } // 0 = domingo
function mondayOnOrAfter(dateISO) {
  const wd = weekdayISO(dateISO);
  return addDaysISO(dateISO, wd === 1 ? 0 : (8 - wd) % 7);
}

function computeRestDays(orgId) {
  const since = restSince(orgId);
  const today = todayISOInBogota();
  const compKey = compensatorioKey(orgId);
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

  // Dias de Compensatorio en el cuadro de turnos.
  const used = new Map();
  if (compKey) {
    for (const r of db.prepare('SELECT data_json FROM shifts WHERE organization_id = ? AND data_json LIKE ?').all(orgId, `%"absenceType":"${compKey}"%`)) {
      let s; try { s = JSON.parse(r.data_json); } catch { continue; }
      if (!s || s.absenceType !== compKey || !s.date || s.date < since || !ids.has(Number(s.empId))) continue;
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
    since, today, compKey,
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

module.exports = { listRestDays, addRestDayMove, computeRestDays };
