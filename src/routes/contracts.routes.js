'use strict';
// ---------------------------------------------------------------------------
// CONTRATOS A TERMINO FIJO: vencimiento, renovacion y preaviso
//
//  - Aviso desde 35 dias antes de la terminacion (campana y Documentos
//    laborales -> Contratos), para alcanzar a entregar el preaviso.
//  - Art. 46 CST: si ninguna parte avisa por escrito que no renueva, con al
//    menos 30 dias de anticipacion, el contrato se renueva por un periodo
//    igual. Si el contrato es de menos de 1 año, se puede prorrogar hasta 3
//    veces por periodos iguales o inferiores; desde la 4.a prorroga, el
//    periodo no puede ser inferior a 1 año.
//  - Renovar: calcula la nueva fecha de terminacion (mismo periodo o el que se
//    elija) y lleva la cuenta de prorrogas. La fecha de inicio del contrato
//    (ingreso) no cambia.
//  - No renovar: queda registrado y, si se quiere, se genera la carta de
//    preaviso (se envia, se recibe y se firma igual que los llamados).
//  - Solo el Administrador (permiso employees.edit_payroll).
// ---------------------------------------------------------------------------
const { db, uid } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { todayISOInBogota, addDaysISO } = require('../lib/bogota-time');
const discipline = require('./discipline.routes');

db.exec(`
CREATE TABLE IF NOT EXISTS contract_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('renovacion', 'no_renovacion')),
  period_start TEXT, period_end TEXT,
  new_end TEXT, months INTEGER, prorroga_n INTEGER,
  note TEXT, notice_case_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
);
CREATE INDEX IF NOT EXISTS idx_contract_events_emp ON contract_events(organization_id, employee_id, created_at);
`);

const ALERT_DAYS = 35;
const NOTICE_DAYS = 30;

const fmt = (iso) => String(iso || '').slice(0, 10).split('-').reverse().join('/');
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function addMonthsISO(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
// Duracion de un periodo [inicio, fin] en meses exactos (null si no son meses completos).
function wholeMonths(start, end) {
  for (let m = 1; m <= 60; m++) {
    const e = addDaysISO(addMonthsISO(start, m), -1);
    if (e === end) return m;
    if (e > end) return null;
  }
  return null;
}
function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}
function eventsOf(orgId, empId) {
  return db.prepare('SELECT * FROM contract_events WHERE organization_id = ? AND employee_id = ? ORDER BY created_at').all(orgId, Number(empId));
}
// Estado del contrato de un colaborador: periodo actual, prorrogas, regla y decision.
function contractState(orgId, emp, today) {
  const ev = eventsOf(orgId, emp.id);
  const ren = ev.filter(e => e.kind === 'renovacion');
  const end = emp.contract_end;
  // Periodo actual: desde la ultima renovacion (dia siguiente al fin anterior) o desde el inicio del contrato.
  const last = ren[ren.length - 1];
  const periodStart = last ? addDaysISO(last.period_end, 1) : (emp.contract_start || null);
  // Periodo inicial (para la regla de las 3 prorrogas).
  const initialEnd = ren.length ? ren[0].period_end : end;
  const initialMonths = emp.contract_start && initialEnd ? wholeMonths(emp.contract_start, initialEnd) : null;
  const initialDays = emp.contract_start && initialEnd ? daysBetween(emp.contract_start, initialEnd) + 1 : null;
  const shortContract = initialDays != null && initialDays < 365;
  const nextN = ren.length + 1;
  const minMonths = shortContract && nextN >= 4 ? 12 : null;
  const curMonths = periodStart && end ? wholeMonths(periodStart, end) : null;
  const curDays = periodStart && end ? daysBetween(periodStart, end) + 1 : null;
  const decision = ev.filter(e => e.kind === 'no_renovacion' && e.period_end === end).pop() || null;
  const daysLeft = end ? daysBetween(today, end) : null;
  return {
    employeeId: emp.id, name: emp.name, area: emp.department || 'Sin área', role: emp.role || '',
    contractStart: emp.contract_start || '', periodStart: periodStart || '', end: end || '', daysLeft,
    noticeDeadline: end ? addDaysISO(end, -NOTICE_DAYS) : '', noticeLate: end ? today > addDaysISO(end, -NOTICE_DAYS) : false,
    prorrogas: ren.length, nextProrroga: nextN, shortContract, initialMonths, initialDays, minMonths,
    suggestedMonths: minMonths ? Math.max(minMonths, curMonths || 0) : (curMonths || null), suggestedDays: curMonths ? null : curDays,
    curMonths, curDays,
    decision: decision ? { kind: 'no_renovacion', at: decision.created_at, note: decision.note || '', noticeCaseId: decision.notice_case_id || '' } : null,
  };
}

// GET /api/contracts -> por vencer (35 dias), vencidos sin decision y no renovados; historial.
function listContracts(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const today = todayISOInBogota();
  const emps = db.prepare(`SELECT * FROM employees WHERE organization_id = ? AND COALESCE(status, 'activo') != 'retirado'
      AND contract_type = 'fijo' AND contract_end IS NOT NULL AND contract_end != ''`).all(orgId);
  const items = emps.map(e => contractState(orgId, e, today))
    .filter(s => s.daysLeft <= ALERT_DAYS || s.decision)
    .sort((a, b) => a.end.localeCompare(b.end) || a.name.localeCompare(b.name, 'es'));
  const missing = db.prepare(`SELECT id, name, department FROM employees WHERE organization_id = ? AND COALESCE(status, 'activo') != 'retirado'
      AND contract_type = 'fijo' AND (contract_end IS NULL OR contract_end = '')`).all(orgId).map(e => ({ employeeId: e.id, name: e.name, area: e.department || 'Sin área' }));
  const names = new Map(db.prepare('SELECT id, name FROM employees WHERE organization_id = ?').all(orgId).map(e => [e.id, e.name]));
  const history = db.prepare(`SELECT c.*, u.email AS by_email FROM contract_events c LEFT JOIN users u ON u.id = c.created_by
      WHERE c.organization_id = ? ORDER BY c.created_at DESC LIMIT 200`).all(orgId)
    .map(h => ({ id: h.id, employeeId: h.employee_id, name: names.get(h.employee_id) || '', kind: h.kind, periodStart: h.period_start || '', periodEnd: h.period_end || '',
      newEnd: h.new_end || '', months: h.months, prorroga: h.prorroga_n, note: h.note || '', noticeCaseId: h.notice_case_id || '', at: h.created_at, by: h.by_email || '' }));
  sendJson(res, 200, { today, alertDays: ALERT_DAYS, noticeDays: NOTICE_DAYS, items, missing, history });
}

// GET /api/contracts/:id -> estado e historial de un colaborador (ficha).
function employeeContract(req, res, params) {
  const orgId = resolveOrgId(req, {});
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(Number(params.id), orgId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  const st = emp.contract_type === 'fijo' && emp.contract_end ? contractState(orgId, emp, todayISOInBogota()) : null;
  const history = eventsOf(orgId, emp.id).reverse().map(h => ({ kind: h.kind, periodStart: h.period_start, periodEnd: h.period_end, newEnd: h.new_end, months: h.months, prorroga: h.prorroga_n, note: h.note || '', at: h.created_at }));
  sendJson(res, 200, { state: st, history, alertDays: ALERT_DAYS });
}

function loadFixed(orgId, id) {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(Number(id), orgId);
  if (!emp) return { error: [404, 'Colaborador no encontrado.'] };
  if (emp.status === 'retirado') return { error: [409, 'El colaborador está retirado.'] };
  if (emp.contract_type !== 'fijo' || !emp.contract_end) return { error: [409, 'El colaborador no tiene un contrato a término fijo con fecha de terminación.'] };
  return { emp };
}

// POST /api/contracts/:id/renew { months } | { until } , note
async function renewContract(req, res, params) {
  let body; try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const { emp, error } = loadFixed(orgId, params.id);
  if (error) return sendJson(res, error[0], { error: error[1] });
  const st = contractState(orgId, emp, todayISOInBogota());
  const newStart = addDaysISO(emp.contract_end, 1);
  let newEnd, months = null;
  if (body.until) {
    newEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(body.until)) ? String(body.until) : '';
    if (!newEnd || newEnd <= emp.contract_end) return sendJson(res, 400, { error: 'La nueva fecha de terminación debe ser posterior a la actual.' });
    months = wholeMonths(newStart, newEnd);
  } else {
    months = Math.round(Number(body.months));
    if (!(months >= 1 && months <= 60)) return sendJson(res, 400, { error: 'Escribe la duración de la renovación en meses (1 a 60).' });
    newEnd = addDaysISO(addMonthsISO(newStart, months), -1);
  }
  const days = daysBetween(newStart, newEnd) + 1;
  if (st.minMonths && days < 365) return sendJson(res, 400, { error: `Esta sería la prórroga n.º ${st.nextProrroga} de un contrato de menos de un año: por ley (art. 46 CST), desde la 4.ª prórroga el periodo no puede ser inferior a 1 año.` });
  const note = String(body.note || '').trim().slice(0, 500);
  const id = uid('cev');
  db.prepare(`INSERT INTO contract_events (id, organization_id, employee_id, kind, period_start, period_end, new_end, months, prorroga_n, note, created_by)
              VALUES (?, ?, ?, 'renovacion', ?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, emp.id, st.periodStart || null, emp.contract_end, newEnd, months, st.nextProrroga, note || null, req.user.id);
  db.prepare('UPDATE employees SET contract_end = ? WHERE id = ? AND organization_id = ?').run(newEnd, emp.id, orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'contract.renew', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, prorroga: st.nextProrroga, antes: emp.contract_end, nuevaTerminacion: newEnd, meses: months, dias: days, nota: note || null } });
  // La fecha de terminacion es dato de la ficha: sube la version (las demas pestanas recargan).
  const dataVersion = require('./org.routes').bumpDataVersion(orgId);
  sendJson(res, 200, { ok: true, newEnd, prorroga: st.nextProrroga, months, days, dataVersion });
}

// Carta de preaviso sugerida (editable antes de generarla).
const NOTICE_TITLE = 'Preaviso de terminación del contrato de trabajo a término fijo';
const NOTICE_BODY = `{{ciudad_fecha}}

Señor(a)
{{nombre}}
{{documento}}
Cargo: {{cargo}}

Asunto: Preaviso de no renovación del contrato de trabajo a término fijo

Por medio de la presente, {{empresa}} le informa que el contrato de trabajo a término fijo suscrito con usted, cuyo periodo actual va del {{inicio_periodo}} al {{fecha_terminacion}}, no será renovado, de conformidad con el numeral 1 del artículo 46 del Código Sustantivo del Trabajo.{{frase_anticipacion}}

En consecuencia, su contrato terminará el {{fecha_terminacion}}, que será su último día de trabajo. Le solicitamos acercarse al área de Recursos Humanos para coordinar la entrega de su cargo y de los elementos asignados, y el trámite de su liquidación y paz y salvo.

Agradecemos los servicios prestados y le deseamos éxito en sus proyectos.

Atentamente,


{{firmante}}
{{empresa}}
NIT {{nit}}`;
function noticeText(orgId, emp, st) {
  const vars = discipline.noticeVars(orgId, emp, {
    fecha_terminacion: discipline.longDate(emp.contract_end), inicio_periodo: st.periodStart ? discipline.longDate(st.periodStart) : '(sin fecha de inicio)',
    // Solo se afirma la anticipación de 30 días si todavía se está a tiempo.
    frase_anticipacion: st.noticeLate ? '' : ' Esta comunicación se le entrega con una anticipación no inferior a treinta (30) días a la fecha de terminación.',
  });
  return { title: NOTICE_TITLE, body: discipline.fillTemplate(NOTICE_BODY, vars) };
}
// GET /api/contracts/:id/notice-draft
function noticeDraft(req, res, params) {
  const orgId = resolveOrgId(req, {});
  const { emp, error } = loadFixed(orgId, params.id);
  if (error) return sendJson(res, error[0], { error: error[1] });
  const st = contractState(orgId, emp, todayISOInBogota());
  sendJson(res, 200, { ...noticeText(orgId, emp, st), daysLeft: st.daysLeft, noticeLate: st.noticeLate, noticeDeadline: st.noticeDeadline });
}

// POST /api/contracts/:id/no-renew { note, notice: { title, body } | null }
async function noRenewContract(req, res, params) {
  let body; try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const { emp, error } = loadFixed(orgId, params.id);
  if (error) return sendJson(res, error[0], { error: error[1] });
  const st = contractState(orgId, emp, todayISOInBogota());
  if (st.decision) return sendJson(res, 409, { error: 'Ya se registró que este contrato no se renueva.' });
  const note = String(body.note || '').trim().slice(0, 500);
  let caseId = null;
  if (body.notice) {
    const title = String(body.notice.title || '').trim(), text = String(body.notice.body || '').trim();
    if (!title || text.length < 40) return sendJson(res, 400, { error: 'Revisa el título y el texto de la carta de preaviso.' });
    caseId = discipline.createNoticeCase(orgId, emp.id, title, text, req.user.id);
  }
  db.prepare(`INSERT INTO contract_events (id, organization_id, employee_id, kind, period_start, period_end, note, notice_case_id, created_by)
              VALUES (?, ?, ?, 'no_renovacion', ?, ?, ?, ?, ?)`).run(uid('cev'), orgId, emp.id, st.periodStart || null, emp.contract_end, note || null, caseId, req.user.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'contract.no_renew', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, terminacion: emp.contract_end, preaviso: !!caseId, diasAntes: st.daysLeft, nota: note || null } });
  sendJson(res, 200, { ok: true, caseId });
}

// POST /api/contracts/:id/undo-no-renew -> deshace la decision (si la carta no se ha enviado).
async function undoNoRenew(req, res, params) {
  let body; try { body = await readBody(req); } catch { body = {}; }
  const orgId = resolveOrgId(req, body);
  const { emp, error } = loadFixed(orgId, params.id);
  if (error) return sendJson(res, error[0], { error: error[1] });
  const ev = db.prepare("SELECT * FROM contract_events WHERE organization_id = ? AND employee_id = ? AND kind = 'no_renovacion' AND period_end = ? ORDER BY created_at DESC LIMIT 1").get(orgId, emp.id, emp.contract_end);
  if (!ev) return sendJson(res, 404, { error: 'No hay una decisión de no renovar para este periodo.' });
  if (ev.notice_case_id) {
    const c = db.prepare('SELECT status, annulled_at FROM discipline_cases WHERE id = ?').get(ev.notice_case_id);
    if (c && c.status !== 'generado' && !c.annulled_at) return sendJson(res, 409, { error: 'La carta de preaviso ya se envió: primero anúlala en el historial de preavisos.' });
    if (c && c.status === 'generado') db.prepare("UPDATE discipline_cases SET status = 'descartado', discard_reason = 'Se deshizo la decisión de no renovar.' WHERE id = ?").run(ev.notice_case_id);
  }
  db.prepare('DELETE FROM contract_events WHERE id = ?').run(ev.id);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'contract.undo_no_renew', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, terminacion: emp.contract_end } });
  sendJson(res, 200, { ok: true });
}

// Campana: contratos por vencer (desde 35 dias antes) sin decision.
function bellItems(orgId) {
  const today = todayISOInBogota();
  const emps = db.prepare(`SELECT * FROM employees WHERE organization_id = ? AND COALESCE(status, 'activo') != 'retirado'
      AND contract_type = 'fijo' AND contract_end IS NOT NULL AND contract_end != '' AND contract_end <= ?`).all(orgId, addDaysISO(today, ALERT_DAYS));
  return emps.map(e => contractState(orgId, e, today)).filter(s => !s.decision && s.daysLeft >= -60).map(s => ({
    id: 'contrato:' + s.employeeId + ':' + s.end, type: 'contrato', label: s.daysLeft < 0 ? 'Contrato vencido' : 'Contrato por vencer',
    employeeId: s.employeeId, employeeName: s.name, department: s.area, date: s.end,
    createdAt: (s.daysLeft < 0 ? s.end : addDaysISO(s.end, -ALERT_DAYS)) + ' 07:00:00', mgmt: 'contrato',
    text: s.daysLeft < 0 ? `Su contrato a término fijo venció el ${fmt(s.end)} sin decisión: por ley se entiende renovado por un periodo igual. Regístralo.`
      : `Su contrato a término fijo vence el ${fmt(s.end)} (en ${s.daysLeft} día${s.daysLeft === 1 ? '' : 's'}). Decide si se renueva${s.noticeLate ? '' : `; el preaviso debe entregarse a más tardar el ${fmt(s.noticeDeadline)}`}.`,
  }));
}

module.exports = { listContracts, employeeContract, renewContract, noticeDraft, noRenewContract, undoNoRenew, bellItems, ALERT_DAYS };
