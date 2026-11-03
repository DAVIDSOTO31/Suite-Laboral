'use strict';
// ---------------------------------------------------------------------------
// SALARIO MINIMO DEL AÑO E HISTORIAL DE SALARIOS
//
//  - El Administrador programa el nuevo salario minimo (el del decreto del
//    Gobierno) con la fecha desde la que rige (normalmente el 1 de enero).
//  - Ese dia la suite actualiza SOLA a los colaboradores con contrato laboral
//    (termino indefinido o fijo, activos) que ganan EXACTAMENTE el minimo
//    anterior. A quienes ganan mas no se les toca (su aumento se acuerda entre
//    la empresa y el colaborador y se cambia en la ficha). Los contratos de
//    prestacion de servicios no se rigen por el salario minimo: no se tocan.
//  - Cada cambio de salario queda con su fecha en employee_salary_history, para
//    que la liquidacion de extras y recargos use el salario VIGENTE EN CADA DIA
//    (un periodo que cruza el cambio de año se liquida bien aunque se cierre
//    despues).
// ---------------------------------------------------------------------------
const { db, uid } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const bogota = require('../lib/bogota-time');

db.exec(`
CREATE TABLE IF NOT EXISTS min_wage_schedule (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'programado',
  previous_amount REAL NULL,
  applied_at TEXT NULL,
  applied_count INTEGER NULL,
  created_by TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
);
CREATE INDEX IF NOT EXISTS idx_min_wage_org ON min_wage_schedule(organization_id, status);
CREATE TABLE IF NOT EXISTS employee_salary_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  salary REAL NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NULL,
  created_by TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
);
CREATE INDEX IF NOT EXISTS idx_salary_hist_emp ON employee_salary_history(organization_id, employee_id, effective_from);
`);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LABOR = ['indefinido', 'fijo'];
const BASE_FROM = '1900-01-01'; // salario que traía antes del primer cambio registrado

function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}
function currentMinimum(orgId) {
  const r = db.prepare('SELECT minimum_wage FROM org_settings WHERE organization_id = ?').get(orgId);
  return (r && Number(r.minimum_wage)) || 1750905;
}
// Año del salario minimo vigente (el del ultimo cambio aplicado; si no hay, 2026).
function minimumYear(orgId) {
  const r = db.prepare("SELECT effective_from FROM min_wage_schedule WHERE organization_id = ? AND status = 'aplicado' ORDER BY effective_from DESC LIMIT 1").get(orgId);
  return r ? Number(r.effective_from.slice(0, 4)) : 2026;
}

// Registra un cambio de salario con su fecha. Si el colaborador no tenia
// historial, primero guarda su salario anterior como base.
function recordSalaryChange(orgId, employeeId, before, after, from, source, reason, userId) {
  const has = db.prepare('SELECT 1 FROM employee_salary_history WHERE organization_id = ? AND employee_id = ? LIMIT 1').get(orgId, employeeId);
  if (!has && Number(before) > 0) {
    db.prepare('INSERT INTO employee_salary_history (id, organization_id, employee_id, effective_from, salary, source, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid('sal'), orgId, employeeId, BASE_FROM, Number(before), 'inicial', null, userId || null);
  }
  // Un solo valor por fecha: el ultimo cambio de ese dia es el que vale.
  db.prepare('DELETE FROM employee_salary_history WHERE organization_id = ? AND employee_id = ? AND effective_from = ?').run(orgId, employeeId, from);
  db.prepare('INSERT INTO employee_salary_history (id, organization_id, employee_id, effective_from, salary, source, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uid('sal'), orgId, employeeId, from, Number(after), source, reason || null, userId || null);
}
// { employeeId: [{ from, salary }] } ordenado por fecha (para la liquidacion).
function salaryHistoryMap(orgId) {
  const map = {};
  for (const r of db.prepare('SELECT employee_id, effective_from, salary FROM employee_salary_history WHERE organization_id = ? ORDER BY effective_from ASC, created_at ASC').all(orgId)) {
    (map[r.employee_id] = map[r.employee_id] || []).push({ from: r.effective_from, salary: r.salary });
  }
  return map;
}

// Quienes se actualizan (contrato laboral, activos, ganan exactamente el minimo
// anterior) y quienes quedarian por debajo del nuevo minimo (para revisarlos).
function affected(orgId, oldMin, newMin) {
  const emps = db.prepare("SELECT id, name, department, salary, contract_type, status FROM employees WHERE organization_id = ? AND COALESCE(status, 'activo') != 'retirado'").all(orgId);
  const labor = emps.filter(e => LABOR.includes(e.contract_type || 'indefinido'));
  const toUpdate = labor.filter(e => Math.round(Number(e.salary) || 0) === Math.round(oldMin));
  const below = labor.filter(e => !toUpdate.includes(e) && (Number(e.salary) || 0) < newMin);
  const out = (e) => ({ id: e.id, name: e.name, department: e.department || '', salary: Number(e.salary) || 0 });
  return { toUpdate: toUpdate.map(out), below: below.map(out) };
}

// Aplica un cambio programado (cuando llega su fecha).
function applySchedule(row, userId) {
  const orgId = row.organization_id;
  const oldMin = currentMinimum(orgId);
  const newMin = Number(row.amount);
  const { toUpdate, below } = affected(orgId, oldMin, newMin);
  db.exec('BEGIN');
  try {
    const up = db.prepare('UPDATE employees SET salary = ? WHERE id = ? AND organization_id = ?');
    for (const e of toUpdate) {
      up.run(newMin, e.id, orgId);
      recordSalaryChange(orgId, e.id, oldMin, newMin, row.effective_from, 'minimo', `Salario mínimo ${row.effective_from.slice(0, 4)}`, userId);
    }
    if (db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId)) db.prepare('UPDATE org_settings SET minimum_wage = ? WHERE organization_id = ?').run(newMin, orgId);
    else db.prepare("INSERT INTO org_settings (organization_id, org_name, minimum_wage) VALUES (?, 'Empresa', ?)").run(orgId, newMin);
    db.prepare("UPDATE min_wage_schedule SET status = 'aplicado', previous_amount = ?, applied_at = datetime('now', '-5 hours'), applied_count = ? WHERE id = ?").run(oldMin, toUpdate.length, row.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nada */ }
    throw e;
  }
  logAction({ organizationId: orgId, userId: userId || null, action: 'payroll.min_wage_applied', resourceType: 'organization', resourceId: orgId,
    metadata: { rigeDesde: row.effective_from, anterior: oldMin, nuevo: newMin, actualizados: toUpdate.map(e => e.name), quedanPorDebajo: below.map(e => `${e.name} (${Math.round(e.salary)})`) } });
  try { require('./org.routes').bumpDataVersion(orgId); } catch { /* sin aviso */ }
  try { require('../lib/live').publish(orgId, { scopes: ['data', 'payroll'], kind: 'min_wage' }); } catch { /* nada */ }
  return { updated: toUpdate, below };
}
// Revisa los cambios programados que ya deben regir (al arrancar y cada hora).
function applyDue(orgId) {
  const today = bogota.todayISOInBogota();
  const rows = orgId
    ? db.prepare("SELECT * FROM min_wage_schedule WHERE organization_id = ? AND status = 'programado' AND effective_from <= ? ORDER BY effective_from").all(orgId, today)
    : db.prepare("SELECT * FROM min_wage_schedule WHERE status = 'programado' AND effective_from <= ? ORDER BY effective_from").all(today);
  for (const r of rows) {
    try { applySchedule(r, r.created_by); } catch (e) { console.error('[salario minimo]', e.message); }
  }
  return rows.length;
}
try { applyDue(); } catch (e) { console.error('[salario minimo]', e.message); }
const dueTimer = setInterval(() => { try { applyDue(); } catch { /* nada */ } }, 60 * 60 * 1000);
if (dueTimer.unref) dueTimer.unref();

// GET /api/payroll/min-wage?amount=  -> estado + vista previa de a quien aplica
function getMinWage(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  applyDue(orgId);
  const current = currentMinimum(orgId);
  const scheduled = db.prepare("SELECT id, effective_from AS effectiveFrom, amount, created_at AS createdAt FROM min_wage_schedule WHERE organization_id = ? AND status = 'programado' ORDER BY effective_from").all(orgId);
  const history = db.prepare("SELECT effective_from AS effectiveFrom, amount, previous_amount AS previousAmount, applied_at AS appliedAt, applied_count AS appliedCount FROM min_wage_schedule WHERE organization_id = ? AND status = 'aplicado' ORDER BY effective_from DESC LIMIT 10").all(orgId);
  const amount = Number(query.amount);
  const preview = Number.isFinite(amount) && amount > 0 ? affected(orgId, current, amount) : affected(orgId, current, current);
  sendJson(res, 200, { current, year: minimumYear(orgId), scheduled, history, preview });
}
// POST /api/payroll/min-wage { amount, effectiveFrom }
async function scheduleMinWage(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const amount = Math.round(Number(body.amount));
  const from = String(body.effectiveFrom || '');
  if (!ISO.test(from)) return sendJson(res, 400, { error: 'Elige la fecha desde la que rige.' });
  const current = currentMinimum(orgId);
  if (!(amount > 0) || amount <= current) return sendJson(res, 400, { error: `El nuevo salario mínimo debe ser mayor que el actual ($${Math.round(current).toLocaleString('es-CO')}).` });
  if (amount > current * 1.5) return sendJson(res, 400, { error: 'Revisa el valor: es más de 50 % mayor que el salario mínimo actual.' });
  if (db.prepare("SELECT 1 FROM min_wage_schedule WHERE organization_id = ? AND status = 'programado'").get(orgId)) {
    return sendJson(res, 409, { error: 'Ya hay un cambio programado. Cancélalo primero para programar otro.' });
  }
  const id = uid('smm');
  db.prepare('INSERT INTO min_wage_schedule (id, organization_id, effective_from, amount, created_by) VALUES (?, ?, ?, ?, ?)').run(id, orgId, from, amount, req.user.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'payroll.min_wage_scheduled', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req),
    metadata: { rigeDesde: from, anterior: current, nuevo: amount } });
  let applied = null;
  if (from <= bogota.todayISOInBogota()) {
    const r = applySchedule(db.prepare('SELECT * FROM min_wage_schedule WHERE id = ?').get(id), req.user.id);
    applied = { updated: r.updated.length, below: r.below };
  }
  sendJson(res, 200, { ok: true, id, applied });
}
// POST /api/payroll/min-wage/:id/cancel
async function cancelMinWage(req, res, params) {
  const orgId = resolveOrgId(req, {});
  const row = db.prepare("SELECT * FROM min_wage_schedule WHERE id = ? AND organization_id = ? AND status = 'programado'").get(String(params.id), orgId);
  if (!row) return sendJson(res, 404, { error: 'No hay un cambio programado con ese identificador.' });
  db.prepare("UPDATE min_wage_schedule SET status = 'cancelado' WHERE id = ?").run(row.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'payroll.min_wage_cancelled', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req),
    metadata: { rigeDesde: row.effective_from, nuevo: row.amount } });
  sendJson(res, 200, { ok: true });
}

module.exports = { recordSalaryChange, salaryHistoryMap, minimumYear, applyDue, getMinWage, scheduleMinWage, cancelMinWage, ISO };
