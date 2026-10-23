'use strict';
// ---------------------------------------------------------------------------
// LLAMADOS DE ATENCION (comunicacion de novedades y citacion a descargos)
//
//  - Reglas por organizacion: N novedades INJUSTIFICADAS de un tipo en los
//    ultimos D dias (llegada tarde, exceso de almuerzo, no se presento, turno
//    sin cerrar). Las justificadas o pendientes nunca cuentan.
//  - Cuando alguien cumple una regla, la suite PROPONE el llamado ("Por
//    revisar"). Nada se envia solo: el administrador lo genera (puede editar el
//    texto), lo descarta con motivo o lo deja para despues.
//  - Cada novedad se usa en UN solo llamado (aunque se descarte), para no
//    repetir el mismo caso todos los dias.
//  - El documento es una comunicacion de novedades con citacion a descargos (no
//    una sancion), en respeto del debido proceso. Plantillas sugeridas por tipo,
//    editables por la organizacion.
//  - Entrega: enlace seguro (vence en 15 dias) que se envia por WhatsApp desde
//    el celular del administrador. El colaborador lo abre, pulsa "Recibido" y
//    puede escribir sus descargos. Todo queda en el historial.
// ---------------------------------------------------------------------------
const { db, uid } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { randomToken, sha256Hex } = require('../lib/crypto');
const { todayISOInBogota, addDaysISO } = require('../lib/bogota-time');

db.exec(`
CREATE TABLE IF NOT EXISTS discipline_cases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  rule_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'propuesto' CHECK (status IN ('propuesto','descartado','generado','enviado','recibido')),
  alert_ids TEXT NOT NULL,
  window_from TEXT, window_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours')),
  decided_by TEXT, decided_at TEXT, discard_reason TEXT,
  doc_title TEXT, doc_body TEXT, doc_date TEXT, descargos_until TEXT,
  token_hash TEXT, token_expires TEXT,
  sent_at TEXT, sent_by TEXT,
  received_at TEXT, received_ip TEXT,
  descargos_text TEXT, descargos_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discipline_org ON discipline_cases(organization_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discipline_token ON discipline_cases(token_hash);
`);
const stCols = db.prepare('PRAGMA table_info(org_settings)').all().map(c => c.name);
if (!stCols.includes('discipline_config')) db.exec('ALTER TABLE org_settings ADD COLUMN discipline_config TEXT NULL');
// Anulacion de un llamado ya enviado (queda "descartado" + estos datos).
const dcCols = db.prepare('PRAGMA table_info(discipline_cases)').all().map(c => c.name);
for (const col of ['annulled_at', 'annulled_by', 'annul_reason']) if (!dcCols.includes(col)) db.exec(`ALTER TABLE discipline_cases ADD COLUMN ${col} TEXT NULL`);

const TYPES = ['llegada_tarde', 'exceso_almuerzo', 'inasistencia', 'turno_sin_cerrar'];
const TYPE_LABEL = { llegada_tarde: 'Llegadas tarde', exceso_almuerzo: 'Exceso en el tiempo de almuerzo', inasistencia: 'Inasistencia sin justificar', turno_sin_cerrar: 'Turnos sin marcar la salida' };
const DEFAULT_RULES = {
  llegada_tarde: { on: true, count: 3, days: 30 },
  exceso_almuerzo: { on: true, count: 3, days: 30 },
  inasistencia: { on: true, count: 1, days: 30 },
  turno_sin_cerrar: { on: true, count: 3, days: 30 },
};
const DESCARGOS_DAYS = 5;
const LINK_DAYS = 15;

// Plantillas sugeridas. Variables: {{empresa}} {{ciudad_fecha}} {{nombre}} {{documento}} {{cargo}}
// {{area}} {{novedades}} {{cantidad}} {{fecha_descargos}} {{firmante}} {{cargo_firmante}} {{nit}}
const BASE_HEAD = `{{ciudad_fecha}}

Señor(a)
{{nombre}}
{{documento}}
Cargo: {{cargo}} · Área: {{area}}

`;
const BASE_TAIL = `

En garantía de su derecho al debido proceso, le invitamos a presentar sus descargos por escrito, a más tardar el {{fecha_descargos}}, y a aportar las pruebas que considere pertinentes. Puede hacerlo desde el enlace con el que recibió esta comunicación o directamente ante el área de Recursos Humanos.

Esta comunicación no constituye una sanción. Cualquier decisión se tomará después de conocer y valorar sus descargos.

Atentamente,


{{firmante}}
{{empresa}}
NIT {{nit}}`;
const DEFAULT_TEMPLATES = {
  llegada_tarde: {
    title: 'Comunicación de novedades y citación a descargos: llegadas tarde',
    body: BASE_HEAD + `Asunto: Llegadas tarde sin justificación

Por medio de la presente, {{empresa}} le informa que, según los registros del sistema de control de asistencia, se presentaron {{cantidad}} llegadas tarde sin justificación:

{{novedades}}

La puntualidad en el inicio de la jornada hace parte de sus obligaciones como trabajador(a) (artículo 58 del Código Sustantivo del Trabajo), del contrato de trabajo y del reglamento interno de la empresa. Estos retrasos afectan la operación y la organización de los turnos de sus compañeros.` + BASE_TAIL,
  },
  exceso_almuerzo: {
    title: 'Comunicación de novedades y citación a descargos: exceso en el tiempo de almuerzo',
    body: BASE_HEAD + `Asunto: Exceso en el tiempo de almuerzo sin justificación

Por medio de la presente, {{empresa}} le informa que, según los registros del sistema de control de asistencia, en {{cantidad}} ocasiones su regreso del almuerzo superó el tiempo asignado, sin justificación:

{{novedades}}

El respeto del tiempo de descanso asignado hace parte de sus obligaciones como trabajador(a) (artículo 58 del Código Sustantivo del Trabajo), del contrato de trabajo y del reglamento interno de la empresa.` + BASE_TAIL,
  },
  inasistencia: {
    title: 'Comunicación de novedades y citación a descargos: inasistencia',
    body: BASE_HEAD + `Asunto: Inasistencia sin justificación

Por medio de la presente, {{empresa}} le informa que, según los registros del sistema de control de asistencia y el cuadro de turnos, usted no se presentó a laborar en la(s) siguiente(s) fecha(s), sin que a la fecha se haya recibido justificación:

{{novedades}}

La asistencia a la jornada asignada hace parte de sus obligaciones como trabajador(a) (artículo 58 del Código Sustantivo del Trabajo), del contrato de trabajo y del reglamento interno de la empresa. Si cuenta con una incapacidad, permiso u otro soporte, le solicitamos presentarlo junto con sus descargos.` + BASE_TAIL,
  },
  turno_sin_cerrar: {
    title: 'Comunicación de novedades y citación a descargos: turnos sin marcar la salida',
    body: BASE_HEAD + `Asunto: Turnos sin registro de salida

Por medio de la presente, {{empresa}} le informa que, según los registros del sistema de control de asistencia, en {{cantidad}} ocasiones no registró la salida de su turno, sin justificación:

{{novedades}}

El registro completo de las marcaciones (entrada, almuerzo y salida) es necesario para el control de la jornada y el cálculo correcto de sus horas, y hace parte de las instrucciones de la empresa (artículo 58 del Código Sustantivo del Trabajo y reglamento interno).` + BASE_TAIL,
  },
};

function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}
function getConfig(orgId) {
  let c = {};
  try { c = JSON.parse((db.prepare('SELECT discipline_config FROM org_settings WHERE organization_id = ?').get(orgId) || {}).discipline_config || '{}') || {}; } catch { c = {}; }
  const rules = {}, templates = {};
  for (const t of TYPES) {
    const r = (c.rules || {})[t] || {};
    rules[t] = { on: r.on !== undefined ? !!r.on : DEFAULT_RULES[t].on, count: Number(r.count) > 0 ? Math.round(Number(r.count)) : DEFAULT_RULES[t].count, days: Number(r.days) > 0 ? Math.round(Number(r.days)) : DEFAULT_RULES[t].days };
    const tp = (c.templates || {})[t];
    templates[t] = tp && tp.body ? { title: String(tp.title || DEFAULT_TEMPLATES[t].title), body: String(tp.body), custom: true } : { ...DEFAULT_TEMPLATES[t], custom: false };
  }
  return { rules, templates, signer: c.signer || '', signerRole: c.signerRole || '', city: c.city || '' };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function longDate(iso) { const d = new Date(iso + 'T00:00:00Z'); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`; }
function shortDate(iso) { return String(iso || '').split('-').reverse().join('/'); }
function clock12(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ''));
  if (!m) return hm || '';
  const h = Number(m[1]) % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
function noveltyLine(a) {
  let meta = {}; try { meta = JSON.parse(a.metadata_json || '{}') || {}; } catch { meta = {}; }
  const d = shortDate(a.shift_date);
  const min = Math.abs(Number(a.diff_minutes) || 0);
  switch (a.alert_type) {
    case 'llegada_tarde': return `- ${d}: hora de entrada ${clock12(a.scheduled_time)}, llegó a las ${clock12(a.actual_time)} (${min} min tarde).`;
    case 'exceso_almuerzo': return `- ${d}: regresó del almuerzo a las ${clock12(a.actual_time)} (${min} min de exceso).`;
    case 'inasistencia': return `- ${d}: turno ${meta.turno ? String(meta.turno).split(/\s*-\s*/).map(clock12).join(' a ') : 'asignado'}, sin ninguna marcación.`;
    case 'turno_sin_cerrar': return `- ${d}: marcó entrada${meta.entrada ? ' a las ' + clock12(meta.entrada) : ''} y no registró la salida${meta.turno ? ' (turno ' + String(meta.turno).split(/\s*-\s*/).map(clock12).join(' a ') + ')' : ''}.`;
    default: return `- ${d}`;
  }
}

// Busca colaboradores que cumplen alguna regla y crea las propuestas.
function scanOrg(orgId) {
  const cfg = getConfig(orgId);
  const today = todayISOInBogota();
  const used = new Set();
  for (const r of db.prepare('SELECT alert_ids FROM discipline_cases WHERE organization_id = ?').all(orgId)) {
    try { JSON.parse(r.alert_ids).forEach(id => used.add(id)); } catch { /* nada */ }
  }
  const dz = (db.prepare('SELECT day_zero FROM org_settings WHERE organization_id = ?').get(orgId) || {}).day_zero || '';
  const created = [];
  for (const t of TYPES) {
    const rule = cfg.rules[t];
    if (!rule.on) continue;
    const from = addDaysISO(today, -(rule.days - 1));
    const rows = db.prepare(`SELECT a.id, a.employee_id, a.shift_date FROM attendance_alerts a
      JOIN alert_management m ON m.alert_id = a.id
      JOIN employees e ON e.id = a.employee_id AND e.organization_id = a.organization_id
      WHERE a.organization_id = ? AND a.alert_type = ? AND m.status = 'injustificada'
        AND a.shift_date >= ? AND a.shift_date <= ? AND COALESCE(e.status, 'activo') != 'retirado'
      ORDER BY a.shift_date`).all(orgId, t, from, today);
    const byEmp = new Map();
    for (const a of rows) {
      if (used.has(a.id) || (dz && a.shift_date <= dz)) continue;
      if (!byEmp.has(a.employee_id)) byEmp.set(a.employee_id, []);
      byEmp.get(a.employee_id).push(a);
    }
    for (const [empId, list] of byEmp) {
      if (list.length < rule.count) continue;
      const id = uid('disc');
      db.prepare('INSERT INTO discipline_cases (id, organization_id, employee_id, rule_type, alert_ids, window_from, window_to) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, orgId, empId, t, JSON.stringify(list.map(a => a.id)), list[0].shift_date, list[list.length - 1].shift_date);
      list.forEach(a => used.add(a.id));
      created.push({ id, employeeId: empId, type: t, count: list.length });
    }
  }
  return created;
}

function caseAlerts(c) {
  let ids = []; try { ids = JSON.parse(c.alert_ids) || []; } catch { ids = []; }
  if (!ids.length) return [];
  return db.prepare(`SELECT id, shift_date, alert_type, scheduled_time, actual_time, diff_minutes, metadata_json FROM attendance_alerts
    WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY shift_date`).all(...ids);
}
function fillTemplate(text, vars) { return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)); }
// Administrador de la organizacion (el primero creado con el rol org_admin):
// firma por defecto de los llamados, sin importar que usuario los genere.
function orgAdminName(orgId) {
  const u = db.prepare(`SELECT u.display_name, u.email, e.name AS emp_name FROM users u
    JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.name = 'org_admin'
    LEFT JOIN employees e ON e.id = u.employee_id
    WHERE u.organization_id = ? AND u.status = 'active' ORDER BY u.created_at LIMIT 1`).get(orgId);
  if (!u) return '';
  return (u.display_name || u.emp_name || String(u.email || '').split('@')[0] || '').trim();
}
// Firma: nombre configurado en "Reglas y plantillas" (o el administrador), y el cargo si se configuró.
function signerText(orgId, cfg) {
  const name = cfg.signer || orgAdminName(orgId) || 'Recursos Humanos';
  return name + (cfg.signerRole ? '\n' + cfg.signerRole : '');
}
function orgNit(orgId) { return ((db.prepare('SELECT nit FROM organizations WHERE id = ?').get(orgId) || {}).nit || '').trim(); }
function docVars(orgId, c, emp) {
  const cfg = getConfig(orgId);
  const st = db.prepare('SELECT org_name FROM org_settings WHERE organization_id = ?').get(orgId) || {};
  const alerts = caseAlerts(c);
  const today = todayISOInBogota();
  const fecha = longDate(today);
  return {
    empresa: st.org_name || 'La empresa',
    ciudad_fecha: (cfg.city ? cfg.city + ', ' : '') + fecha.charAt(0).toUpperCase() + fecha.slice(1),
    nombre: emp.name, documento: `${emp.document_type || 'C.C.'} ${emp.document_number || ''}`.trim(),
    cargo: emp.role || '-', area: emp.department || '-',
    novedades: alerts.map(noveltyLine).join('\n'), cantidad: String(alerts.length),
    fecha_descargos: longDate(addDaysISO(today, DESCARGOS_DAYS)),
    firmante: signerText(orgId, cfg),
    cargo_firmante: cfg.signerRole || '',
    nit: orgNit(orgId) || '(sin NIT registrado)',
  };
}
function caseOut(c, emp) {
  return {
    id: c.id, employeeId: c.employee_id, name: emp ? emp.name : '', area: emp ? (emp.department || '') : '', role: emp ? (emp.role || '') : '',
    phone: emp && emp.phone_number ? `${String(emp.phone_country || '+57').replace(/[^\d]/g, '')}${String(emp.phone_number).replace(/[^\d]/g, '')}` : '',
    type: c.rule_type, typeLabel: TYPE_LABEL[c.rule_type] || c.rule_type, status: c.status,
    count: (() => { try { return JSON.parse(c.alert_ids).length; } catch { return 0; } })(),
    from: c.window_from, to: c.window_to, createdAt: c.created_at,
    decidedBy: c.decided_by_email || '', decidedAt: c.decided_at, discardReason: c.discard_reason || '',
    docTitle: c.doc_title || '', docBody: c.doc_body || '', docDate: c.doc_date || '', descargosUntil: c.descargos_until || '',
    linkExpires: c.token_expires || '', sentAt: c.sent_at || '', receivedAt: c.received_at || '',
    descargos: c.descargos_text || '', descargosAt: c.descargos_at || '',
    annulledAt: c.annulled_at || '', annulReason: c.annul_reason || '',
  };
}

// GET /api/discipline  -> revisa reglas y devuelve los casos + configuracion
function listCases(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  try { notifyNew(orgId, scanOrg(orgId)); } catch (e) { console.error('[llamados]', e.message); }
  const emps = new Map(db.prepare('SELECT id, name, department, role, phone_country, phone_number FROM employees WHERE organization_id = ?').all(orgId).map(e => [e.id, e]));
  const rows = db.prepare(`SELECT c.*, u.email AS decided_by_email FROM discipline_cases c LEFT JOIN users u ON u.id = c.decided_by
    WHERE c.organization_id = ? ORDER BY c.created_at DESC`).all(orgId);
  const cfg = getConfig(orgId);
  sendJson(res, 200, {
    cases: rows.map(c => {
      const o = caseOut(c, emps.get(c.employee_id));
      if (c.status === 'propuesto') { o.novedades = caseAlerts(c).map(noveltyLine); }
      return o;
    }),
    config: { rules: cfg.rules, templates: cfg.templates, signer: cfg.signer, signerRole: cfg.signerRole, adminName: orgAdminName(orgId), city: cfg.city, nit: orgNit(orgId), defaults: { rules: DEFAULT_RULES, templates: DEFAULT_TEMPLATES } },
    typeLabels: TYPE_LABEL, descargosDays: DESCARGOS_DAYS, linkDays: LINK_DAYS,
  });
}

// GET /api/discipline/:id/draft -> texto sugerido (plantilla con los datos)
function draftCase(req, res, params) {
  const orgId = resolveOrgId(req, {});
  const c = db.prepare('SELECT * FROM discipline_cases WHERE id = ? AND organization_id = ?').get(String(params.id), orgId);
  if (!c) return sendJson(res, 404, { error: 'Llamado no encontrado.' });
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(c.employee_id, orgId);
  const cfg = getConfig(orgId);
  const tpl = cfg.templates[c.rule_type];
  const vars = docVars(orgId, c, emp || {});
  sendJson(res, 200, { title: fillTemplate(tpl.title, vars), body: fillTemplate(tpl.body, vars), novedades: caseAlerts(c).map(noveltyLine) });
}

// POST /api/discipline/:id/decide { action: 'generar'|'descartar', title, body, reason }
async function decideCase(req, res, params) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const c = db.prepare('SELECT * FROM discipline_cases WHERE id = ? AND organization_id = ?').get(String(params.id), orgId);
  if (!c) return sendJson(res, 404, { error: 'Llamado no encontrado.' });
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(c.employee_id) || {};
  if (body.action === 'descartar') {
    // Por revisar, o generado pero aun sin enviar (nadie lo ha visto).
    if (!['propuesto', 'generado'].includes(c.status)) return sendJson(res, 409, { error: c.status === 'descartado' ? 'Este llamado ya está descartado.' : 'Este llamado ya se envió: usa "Anular".' });
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo (mínimo 5 caracteres).' });
    db.prepare("UPDATE discipline_cases SET status = 'descartado', decided_by = ?, decided_at = datetime('now', '-5 hours'), discard_reason = ?, token_hash = NULL WHERE id = ?").run(req.user.id, reason, c.id);
    logAction({ organizationId: orgId, userId: req.user.id, action: 'discipline.discard', resourceType: 'employee', resourceId: String(c.employee_id), ip: getClientIp(req), metadata: { colaborador: emp.name, tipo: TYPE_LABEL[c.rule_type], motivo: reason } });
    return sendJson(res, 200, { ok: true });
  }
  if (body.action === 'anular') {
    // Ya enviado o recibido: queda anulado (el enlace muestra que fue anulado).
    if (!['enviado', 'recibido'].includes(c.status)) return sendJson(res, 409, { error: 'Solo se anula un llamado ya enviado.' });
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo de la anulación (mínimo 5 caracteres).' });
    db.prepare("UPDATE discipline_cases SET status = 'descartado', annulled_at = datetime('now', '-5 hours'), annulled_by = ?, annul_reason = ? WHERE id = ?").run(req.user.id, reason, c.id);
    logAction({ organizationId: orgId, userId: req.user.id, action: 'discipline.annul', resourceType: 'employee', resourceId: String(c.employee_id), ip: getClientIp(req), metadata: { colaborador: emp.name, tipo: TYPE_LABEL[c.rule_type], motivo: reason } });
    return sendJson(res, 200, { ok: true });
  }
  if (body.action === 'generar') {
    if (!['propuesto', 'generado'].includes(c.status)) return sendJson(res, 409, { error: 'Este llamado ya se envió; no se puede modificar.' });
    const title = String(body.title || '').trim().slice(0, 200);
    const text = String(body.body || '').trim().slice(0, 20000);
    if (!title || text.length < 20) return sendJson(res, 400, { error: 'Revisa el título y el texto del documento.' });
    const today = todayISOInBogota();
    db.prepare(`UPDATE discipline_cases SET status = 'generado', decided_by = ?, decided_at = datetime('now', '-5 hours'), doc_title = ?, doc_body = ?, doc_date = ?, descargos_until = ? WHERE id = ?`)
      .run(req.user.id, title, text, today, addDaysISO(today, DESCARGOS_DAYS), c.id);
    logAction({ organizationId: orgId, userId: req.user.id, action: 'discipline.generate', resourceType: 'employee', resourceId: String(c.employee_id), ip: getClientIp(req), metadata: { colaborador: emp.name, tipo: TYPE_LABEL[c.rule_type] } });
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 400, { error: 'Acción no válida.' });
}

// POST /api/discipline/:id/link -> crea (o renueva) el enlace seguro y marca "enviado"
async function createLink(req, res, params) {
  let body; try { body = await readBody(req); } catch { body = {}; }
  const orgId = resolveOrgId(req, body);
  const c = db.prepare('SELECT * FROM discipline_cases WHERE id = ? AND organization_id = ?').get(String(params.id), orgId);
  if (!c) return sendJson(res, 404, { error: 'Llamado no encontrado.' });
  if (!['generado', 'enviado', 'recibido'].includes(c.status)) return sendJson(res, 409, { error: 'Primero genera el documento.' });
  const token = randomToken(24);
  const expires = addDaysISO(todayISOInBogota(), LINK_DAYS);
  db.prepare(`UPDATE discipline_cases SET token_hash = ?, token_expires = ?, sent_at = COALESCE(sent_at, datetime('now', '-5 hours')), sent_by = COALESCE(sent_by, ?),
    status = CASE WHEN status = 'generado' THEN 'enviado' ELSE status END WHERE id = ?`).run(sha256Hex(token), expires, req.user.id, c.id);
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(c.employee_id) || {};
  logAction({ organizationId: orgId, userId: req.user.id, action: 'discipline.send', resourceType: 'employee', resourceId: String(c.employee_id), ip: getClientIp(req), metadata: { colaborador: emp.name, tipo: TYPE_LABEL[c.rule_type], vence: expires } });
  sendJson(res, 200, { ok: true, token, expires });
}

// PUT /api/discipline/config { rules, templates, signer, city }
async function saveConfig(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const out = { rules: {}, templates: {}, signer: String(body.signer || '').trim().slice(0, 120), signerRole: String(body.signerRole || '').trim().slice(0, 120), city: String(body.city || '').trim().slice(0, 60) };
  for (const t of TYPES) {
    const r = (body.rules || {})[t] || {};
    const count = Math.round(Number(r.count)), days = Math.round(Number(r.days));
    if (!(count >= 1 && count <= 50) || !(days >= 1 && days <= 365)) return sendJson(res, 400, { error: `Revisa la regla de ${TYPE_LABEL[t]} (cantidad 1 a 50, días 1 a 365).` });
    out.rules[t] = { on: !!r.on, count, days };
    const tp = (body.templates || {})[t];
    if (tp && tp.body && String(tp.body).trim() !== DEFAULT_TEMPLATES[t].body.trim()) out.templates[t] = { title: String(tp.title || DEFAULT_TEMPLATES[t].title).slice(0, 200), body: String(tp.body).slice(0, 20000) };
  }
  db.prepare('UPDATE org_settings SET discipline_config = ? WHERE organization_id = ?').run(JSON.stringify(out), orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'discipline.config', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req), metadata: { reglas: out.rules, plantillasPropias: Object.keys(out.templates) } });
  sendJson(res, 200, { ok: true });
}

// ---- Enlace publico (sin sesion): el colaborador ve el documento ----
function caseByToken(token) {
  const t = String(token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) return null;
  const c = db.prepare('SELECT * FROM discipline_cases WHERE token_hash = ?').get(sha256Hex(t));
  if (!c || !c.token_expires || c.token_expires < todayISOInBogota()) return null;
  return c;
}
function publicView(req, res, params) {
  const c = caseByToken(params.token);
  if (!c) return sendJson(res, 404, { error: 'Este enlace no es válido o ya venció. Comunícate con Recursos Humanos.' });
  const st = db.prepare('SELECT org_name, logo_base64 FROM org_settings WHERE organization_id = ?').get(c.organization_id) || {};
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(c.employee_id) || {};
  if (c.annulled_at) return sendJson(res, 200, { org: st.org_name || '', nit: orgNit(c.organization_id), logo: st.logo_base64 || null, annulled: true, annulledAt: c.annulled_at });
  sendJson(res, 200, { org: st.org_name || '', nit: orgNit(c.organization_id), logo: st.logo_base64 || null, name: emp.name || '', title: c.doc_title, body: c.doc_body, docDate: c.doc_date,
    descargosUntil: c.descargos_until, receivedAt: c.received_at, descargos: c.descargos_text || '', descargosAt: c.descargos_at || '' });
}
async function publicAck(req, res, params) {
  const c = caseByToken(params.token);
  if (!c) return sendJson(res, 404, { error: 'Este enlace no es válido o ya venció.' });
  if (c.annulled_at || c.status === 'descartado') return sendJson(res, 409, { error: 'Esta comunicación fue anulada por la empresa.' });
  let body; try { body = await readBody(req, 64 * 1024); } catch { body = {}; }
  const ip = getClientIp(req);
  if (!c.received_at) {
    db.prepare("UPDATE discipline_cases SET received_at = datetime('now', '-5 hours'), received_ip = ?, status = 'recibido' WHERE id = ?").run(ip, c.id);
    logAction({ organizationId: c.organization_id, userId: null, action: 'discipline.received', resourceType: 'employee', resourceId: String(c.employee_id), ip, metadata: { tipo: TYPE_LABEL[c.rule_type] } });
  }
  const text = String(body.descargos || '').trim().slice(0, 5000);
  if (text) {
    if (c.descargos_text) return sendJson(res, 409, { error: 'Ya enviaste tus descargos por este medio. Si necesitas agregar algo, comunícate con Recursos Humanos.' });
    db.prepare("UPDATE discipline_cases SET descargos_text = ?, descargos_at = datetime('now', '-5 hours') WHERE id = ?").run(text, c.id);
    logAction({ organizationId: c.organization_id, userId: null, action: 'discipline.descargos', resourceType: 'employee', resourceId: String(c.employee_id), ip, metadata: { tipo: TYPE_LABEL[c.rule_type] } });
  }
  sendJson(res, 200, { ok: true });
}

// ---- Aviso de llamados nuevos por revisar (campana + celular) ----
// La campana los muestra siempre (ver notifications.routes). Al celular se
// avisa al crearse, fuera del horario de silencio.
function notifyNew(orgId, created) {
  if (!created || !created.length) return;
  let push;
  try { push = require('../lib/push'); } catch { return; }
  if (push.isQuietTime()) return;
  const emp = (id) => db.prepare("SELECT name, COALESCE(department, 'Sin área') AS department FROM employees WHERE id = ?").get(id) || { name: 'Colaborador', department: '' };
  const nice = (n) => { const s = String(n || '').trim(); return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase()) : s; };
  let payload;
  if (created.length === 1) {
    const c = created[0], e = emp(c.employeeId);
    payload = { title: `⚖️ ${nice(e.name)}`, body: `Llamado de atención por revisar\n${TYPE_LABEL[c.type]}: ${c.count} novedad(es) injustificada(s)\nÁrea: ${e.department}`, tag: `llamado-${c.id}` };
  } else {
    const lines = created.slice(0, 6).map(c => { const e = emp(c.employeeId); return `⚖️ ${nice(e.name)} · ${TYPE_LABEL[c.type].toLowerCase()} (${e.department})`; });
    if (created.length > 6) lines.push(`… y ${created.length - 6} más`);
    payload = { title: `${created.length} llamados de atención por revisar`, body: lines.join('\n'), tag: `llamados-${Date.now()}` };
  }
  payload.url = '/app.html#llamados';
  payload.actions = [{ action: 'ver', title: 'Revisar' }];
  push.sendToOrgAdmins(orgId, payload).catch(e => console.error('[llamados]', e.message));
}
// Revision periodica de todas las organizaciones activas (cada 10 min).
function scanAll() {
  for (const o of db.prepare("SELECT id FROM organizations WHERE status = 'active'").all()) {
    try { notifyNew(o.id, scanOrg(o.id)); } catch (e) { console.error('[llamados]', e.message); }
  }
}
const scanTimer = setInterval(scanAll, 10 * 60 * 1000);
if (scanTimer.unref) scanTimer.unref();
const firstScan = setTimeout(scanAll, 60 * 1000);
if (firstScan.unref) firstScan.unref();

// Llamados por revisar para la campana (los de los ultimos dias).
function bellItems(orgId, sinceSql) {
  return db.prepare(`SELECT c.id, c.employee_id, c.rule_type, c.alert_ids, c.created_at, e.name AS employee_name, COALESCE(e.department, 'Sin área') AS department
    FROM discipline_cases c JOIN employees e ON e.id = c.employee_id
    WHERE c.organization_id = ? AND c.status = 'propuesto' AND c.created_at >= ? ORDER BY c.created_at DESC`).all(orgId, sinceSql)
    .map(r => {
      let n = 0; try { n = JSON.parse(r.alert_ids).length; } catch { n = 0; }
      return { id: r.id, type: 'llamado', label: 'Llamado por revisar', employeeId: r.employee_id, employeeName: r.employee_name, department: r.department,
        date: String(r.created_at).slice(0, 10), createdAt: r.created_at, mgmt: 'llamado', text: `${TYPE_LABEL[r.rule_type]}: ${n} novedad(es) injustificada(s). Revisa y decide si se genera el llamado.` };
    });
}

module.exports = { bellItems, listCases, draftCase, decideCase, createLink, saveConfig, publicView, publicAck, scanOrg, TYPE_LABEL };
