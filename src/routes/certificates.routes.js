'use strict';
// ---------------------------------------------------------------------------
// CERTIFICADOS LABORALES (modulo "Documentos laborales")
//
//  - Base legal: numeral 7 del articulo 57 del Codigo Sustantivo del Trabajo:
//    el empleador debe certificar el TIEMPO DE SERVICIO, la INDOLE DE LA LABOR
//    (cargo; y funciones si se piden, sentencia T-163 de 2002) y el SALARIO
//    DEVENGADO, al terminar el contrato y tambien durante la relacion cuando
//    el trabajador lo pida (sin condiciones ni limite de veces).
//  - Prestacion de servicios: certificacion propia (no es contrato de trabajo:
//    "presta/presto sus servicios", "honorarios").
//  - Solo el Administrador genera certificados (permiso employees.edit_payroll).
//  - Cada certificado lleva numero consecutivo por año (CL-2026-0001), codigo
//    de verificacion y queda en el historial (se puede anular, nunca borrar).
//  - Verificacion publica con el codigo: solo muestra lo minimo (Ley 1581).
//  - Enlace para el colaborador (WhatsApp manual): ve y descarga su certificado.
// ---------------------------------------------------------------------------
const { db, uid, TRANSPORT_ALLOWANCE } = require('../db');
const { sendJson, readBody, getClientIp } = require('../lib/http');
const { logAction } = require('../lib/audit');
const { randomToken, sha256Hex } = require('../lib/crypto');
const { todayISOInBogota, addDaysISO } = require('../lib/bogota-time');

db.exec(`
CREATE TABLE IF NOT EXISTS work_certificates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  kind TEXT NOT NULL,
  addressed_to TEXT,
  include_salary INTEGER NOT NULL DEFAULT 1,
  include_functions INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT,
  issue_date TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours')),
  issued_by TEXT,
  doc_hash TEXT NOT NULL,
  verify_code TEXT NOT NULL,
  token_hash TEXT, token_expires TEXT,
  sent_at TEXT, sent_by TEXT,
  annulled_at TEXT, annulled_by TEXT, annul_reason TEXT,
  UNIQUE (organization_id, year, seq)
);
CREATE INDEX IF NOT EXISTS idx_work_cert_org ON work_certificates(organization_id, issued_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_cert_verify ON work_certificates(verify_code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_cert_token ON work_certificates(token_hash);
`);
const stCols = db.prepare('PRAGMA table_info(org_settings)').all().map(c => c.name);
if (!stCols.includes('certificate_config')) db.exec('ALTER TABLE org_settings ADD COLUMN certificate_config TEXT NULL');

const LINK_DAYS = 30;
const KINDS = ['laboral', 'servicios'];
const KIND_LABEL = { laboral: 'Certificación laboral', servicios: 'Certificación de prestación de servicios' };

// Plantillas por defecto. Las frases que cambian segun el caso (vigente o
// retirado, con o sin salario, con o sin funciones) las arma la suite en las
// variables {{vinculo}}, {{parrafo_salario}}, {{parrafo_funciones}}...
const DEFAULT_TEMPLATES = {
  laboral: {
    title: 'CERTIFICACIÓN LABORAL',
    body: `{{ciudad_fecha}}

{{dirigido_a}}

{{empresa}}, identificada con NIT {{nit}}, certifica que {{nombre}}, identificado(a) con {{documento}}, {{vinculo}}, mediante {{tipo_contrato}}, desempeñando el cargo de {{cargo}}.

{{parrafo_salario}}

{{parrafo_funciones}}

La presente certificación se expide a solicitud del interesado(a), en cumplimiento de lo dispuesto en el numeral 7 del artículo 57 del Código Sustantivo del Trabajo.

Atentamente,


{{firmante}}
{{empresa}}
NIT {{nit}}`,
  },
  servicios: {
    title: 'CERTIFICACIÓN DE PRESTACIÓN DE SERVICIOS',
    body: `{{ciudad_fecha}}

{{dirigido_a}}

{{empresa}}, identificada con NIT {{nit}}, certifica que {{nombre}}, identificado(a) con {{documento}}, {{vinculo}}, mediante contrato de prestación de servicios, desarrollando actividades como {{cargo}}.

{{parrafo_salario}}

{{parrafo_funciones}}

La presente certificación se expide a solicitud del interesado(a).

Atentamente,


{{firmante}}
{{empresa}}
NIT {{nit}}`,
  },
};

function resolveOrgId(req, extra) {
  if (req.user.organizationId) return req.user.organizationId;
  if (req.user.isSuperAdmin && extra && extra.organization_id) return extra.organization_id;
  return null;
}
// Firma, firmante y ciudad: los mismos de "Reglas y plantillas" de los llamados
// (una sola firma de la empresa para todos sus documentos).
function signerConfig(orgId) {
  let c = {};
  try { c = JSON.parse((db.prepare('SELECT discipline_config FROM org_settings WHERE organization_id = ?').get(orgId) || {}).discipline_config || '{}') || {}; } catch { c = {}; }
  return { signer: c.signer || '', signerRole: c.signerRole || '', city: c.city || '', signerSignature: c.signerSignature || '' };
}
function getConfig(orgId) {
  let c = {};
  try { c = JSON.parse((db.prepare('SELECT certificate_config FROM org_settings WHERE organization_id = ?').get(orgId) || {}).certificate_config || '{}') || {}; } catch { c = {}; }
  const templates = {};
  for (const k of KINDS) {
    const tp = (c.templates || {})[k];
    templates[k] = tp && tp.body ? { title: String(tp.title || DEFAULT_TEMPLATES[k].title), body: String(tp.body), custom: true } : { ...DEFAULT_TEMPLATES[k], custom: false };
  }
  return { templates };
}

// ---- Textos -----------------------------------------------------------------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function longDate(iso) { if (!iso) return ''; const [y, m, d] = String(iso).split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${y}`; }
function money(n) { return '$' + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
// Numero en letras (pesos colombianos): 1750905 -> "UN MILLÓN SETECIENTOS CINCUENTA MIL NOVECIENTOS CINCO PESOS COP"
const U = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DEC = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CEN = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];
function upTo999(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100), r = n % 100;
  let t = CEN[c];
  if (r) t += (t ? ' ' : '') + (r < 30 ? U[r] : DEC[Math.floor(r / 10)] + (r % 10 ? ' y ' + U[r % 10] : ''));
  return t;
}
// "uno" -> "un" delante de mil/millones/pesos ("veintiuno" -> "veintiún").
function apocope(t) { return t.replace(/veintiuno$/, 'veintiún').replace(/(^|\s)uno$/, '$1un'); }
function numberToWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'cero';
  const millones = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000;
  const parts = [];
  if (millones) parts.push(millones === 1 ? 'un millón' : apocope(numberToWords(millones)) + ' millones');
  if (miles) parts.push(miles === 1 ? 'mil' : apocope(upTo999(miles)) + ' mil');
  if (resto) parts.push(upTo999(resto));
  return parts.join(' ');
}
function pesosEnLetras(n) {
  const v = Math.round(Number(n) || 0);
  const w = apocope(numberToWords(v));
  const de = v >= 1e6 && v % 1e6 === 0 ? ' de' : ''; // "dos millones de pesos"
  return `${w}${de} pesos COP`.toUpperCase();
}
const DOC_NAMES = { CC: 'cédula de ciudadanía', CE: 'cédula de extranjería', PPT: 'Permiso por Protección Temporal', PA: 'pasaporte', TI: 'tarjeta de identidad' };
function docPhrase(emp) {
  const t = emp.document_type || 'CC';
  const num = String(emp.document_number || '').trim();
  const n = ['CC', 'TI'].includes(t) && /^\d+$/.test(num) ? num.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : num;
  return `${DOC_NAMES[t] || 'documento'} No. ${n || '__________'}`;
}
function fillTemplate(text, vars) { return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)); }
// Quita los parrafos vacios que dejan las variables opcionales (sin salario, sin funciones).
function tidy(text) { return String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function orgAdminName(orgId) {
  const u = db.prepare(`SELECT u.display_name, u.email, e.name AS emp_name FROM users u
    JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.name = 'org_admin'
    LEFT JOIN employees e ON e.id = u.employee_id
    WHERE u.organization_id = ? AND u.status = 'active' ORDER BY u.created_at LIMIT 1`).get(orgId);
  if (!u) return '';
  return (u.display_name || u.emp_name || String(u.email || '').split('@')[0] || '').trim();
}
function orgNit(orgId) { return ((db.prepare('SELECT nit FROM organizations WHERE id = ?').get(orgId) || {}).nit || '').trim(); }
function orgName(orgId) { return ((db.prepare('SELECT org_name FROM org_settings WHERE organization_id = ?').get(orgId) || {}).org_name || '').trim(); }
// Fecha de ingreso: la registrada en Vacaciones; si no, el inicio del contrato a término fijo.
function hireDateOf(orgId, emp) {
  let r = null;
  try {
    r = db.prepare(`SELECT move_date FROM vacation_moves WHERE organization_id = ? AND employee_id = ? AND kind = 'ingreso' AND voided_at IS NULL
      ORDER BY created_at DESC LIMIT 1`).get(orgId, emp.id);
  } catch { r = null; }
  return (r && r.move_date) || (emp.contract_start || '') || '';
}
const CONTRACT_PHRASE = { indefinido: 'contrato de trabajo a término indefinido', fijo: 'contrato de trabajo a término fijo' };

// Variables del certificado para un colaborador y unas opciones.
function buildVars(orgId, emp, opts) {
  const sc = signerConfig(orgId);
  const today = todayISOInBogota();
  const contract = emp.contract_type || 'indefinido';
  const kind = contract === 'servicios' ? 'servicios' : 'laboral';
  const retired = (emp.status === 'retirado') && !!emp.retired_at;
  const hire = opts.hireDate || hireDateOf(orgId, emp);
  const desde = hire ? longDate(hire) : '__________';
  let vinculo;
  if (kind === 'servicios') vinculo = retired ? `prestó sus servicios a nuestra empresa desde el ${desde} hasta el ${longDate(emp.retired_at)}` : `presta sus servicios a nuestra empresa desde el ${desde}`;
  else vinculo = retired ? `laboró en nuestra empresa desde el ${desde} hasta el ${longDate(emp.retired_at)}` : `labora en nuestra empresa desde el ${desde}`;
  let tipo = CONTRACT_PHRASE[contract] || CONTRACT_PHRASE.indefinido;
  if (contract === 'fijo' && !retired && emp.contract_end && emp.contract_end >= today) tipo += ` con vigencia hasta el ${longDate(emp.contract_end)}`;
  const basic = Math.round(Number(emp.salary) || 0);
  // Auxilio de transporte (término fijo o indefinido): el salario certificado es
  // la suma del básico + el auxilio, con el desglose.
  const auxYear = Number((retired && emp.retired_at ? emp.retired_at : today).slice(0, 4));
  const aux = kind === 'laboral' && emp.transport_allowance === 1 ? (TRANSPORT_ALLOWANCE[auxYear] || TRANSPORT_ALLOWANCE[Math.max(...Object.keys(TRANSPORT_ALLOWANCE).map(Number))] || 0) : 0;
  const salary = basic + aux;
  let pSal = '';
  if (opts.includeSalary && basic > 0) {
    const v = `${pesosEnLetras(salary)} (${money(salary)})`;
    const det = aux ? (retired ? `, que correspondía al salario básico de ${money(basic)} más el auxilio de transporte de ${money(aux)}` : `, que corresponde al salario básico de ${money(basic)} más el auxilio de transporte de ${money(aux)}`) : '';
    pSal = kind === 'servicios'
      ? (retired ? `Sus últimos honorarios mensuales pactados fueron de ${v}.` : `Sus honorarios mensuales pactados son de ${v}.`)
      : aux
        ? (retired ? `Su último salario mensual devengado fue de ${v}${det}.` : `Actualmente devenga un salario mensual de ${v}${det}.`)
        : (retired ? `Su último salario básico mensual devengado fue de ${v}.` : `Actualmente devenga un salario básico mensual de ${v}.`);
  }
  let pFun = '';
  const fn = String(opts.functionsText || '').split('\n').map(s => s.replace(/^[\s\-•*]+/, '').trim()).filter(Boolean);
  if (opts.includeFunctions && fn.length) {
    const head = kind === 'servicios' ? (retired ? 'Entre las actividades que desarrolló se encuentran:' : 'Entre las actividades que desarrolla se encuentran:')
      : (retired ? 'Entre sus funciones estuvieron:' : 'Entre sus funciones se encuentran:');
    pFun = head + '\n' + fn.map(f => '- ' + f).join('\n');
  }
  const addressed = String(opts.addressedTo || '').trim();
  return {
    kind, retired,
    vars: {
      ciudad_fecha: (sc.city ? sc.city + ', ' : '') + longDate(today),
      dirigido_a: addressed && !/^a quien (pueda )?interes/i.test(addressed) ? `Señores\n${addressed}` : 'A QUIEN INTERESE',
      empresa: orgName(orgId) || 'La empresa',
      nit: orgNit(orgId) || '(sin NIT registrado)',
      nombre: String(emp.name || '').toUpperCase(),
      documento: docPhrase(emp),
      vinculo, tipo_contrato: tipo,
      cargo: emp.role || '__________',
      salario: basic ? money(salary) : '',
      salario_letras: basic ? pesosEnLetras(salary) : '',
      salario_basico: basic ? money(basic) : '',
      auxilio_transporte: aux ? money(aux) : '',
      fecha_ingreso: hire ? longDate(hire) : '',
      fecha_retiro: retired ? longDate(emp.retired_at) : '',
      parrafo_salario: pSal,
      parrafo_funciones: pFun,
      firmante: (sc.signer || orgAdminName(orgId) || 'Recursos Humanos') + (sc.signerRole ? '\n' + sc.signerRole : ''),
      cargo_firmante: sc.signerRole || '',
    },
    snapshot: { name: emp.name, documentType: emp.document_type || 'CC', documentNumber: emp.document_number || '', role: emp.role || '', contract, hireDate: hire || '', retiredAt: retired ? emp.retired_at : '', salary: opts.includeSalary ? salary : null, basicSalary: opts.includeSalary ? basic : null, transportAllowance: opts.includeSalary ? aux : null },
  };
}
function render(orgId, emp, opts) {
  const cfg = getConfig(orgId);
  const b = buildVars(orgId, emp, opts);
  const tp = cfg.templates[b.kind];
  return { ...b, title: fillTemplate(tp.title, b.vars), body: tidy(fillTemplate(tp.body, b.vars)) };
}
function readOpts(body) {
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : '';
  return {
    addressedTo: String(body.addressedTo || '').trim().slice(0, 150),
    includeSalary: body.includeSalary !== false,
    includeFunctions: !!body.includeFunctions,
    functionsText: String(body.functionsText || '').slice(0, 3000),
    hireDate: okDate(body.hireDate),
  };
}
function verifyFormat(code) { return String(code).replace(/(.{4})(?=.)/g, '$1-'); }
function certOut(c, emp) {
  let data = {}; try { data = JSON.parse(c.data_json || '{}') || {}; } catch { data = {}; }
  return {
    id: c.id, employeeId: c.employee_id, name: emp ? emp.name : data.name || '', area: emp ? emp.department || '' : '',
    phone: emp && emp.phone_number ? `${String(emp.phone_country || '+57').replace(/[^\d]/g, '')}${String(emp.phone_number).replace(/[^\d]/g, '')}` : '',
    number: c.number, kind: c.kind, kindLabel: KIND_LABEL[c.kind] || c.kind, addressedTo: c.addressed_to || '', includeSalary: !!c.include_salary, includeFunctions: !!c.include_functions,
    title: c.title, body: c.body, issueDate: c.issue_date, issuedAt: c.issued_at, issuedBy: c.issued_by_email || '',
    verifyCode: verifyFormat(c.verify_code), sentAt: c.sent_at || '', annulledAt: c.annulled_at || '', annulReason: c.annul_reason || '', data,
  };
}

// GET /api/certificates -> historial, plantillas, fechas de ingreso conocidas y firma
function listCertificates(req, res, query) {
  const orgId = resolveOrgId(req, query);
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const emps = new Map(db.prepare('SELECT * FROM employees WHERE organization_id = ?').all(orgId).map(e => [Number(e.id), e]));
  const rows = db.prepare(`SELECT c.*, u.email AS issued_by_email FROM work_certificates c LEFT JOIN users u ON u.id = c.issued_by
    WHERE c.organization_id = ? ORDER BY c.issued_at DESC LIMIT 500`).all(orgId);
  const hireDates = {};
  for (const e of emps.values()) { const h = hireDateOf(orgId, e); if (h) hireDates[e.id] = h; }
  const sc = signerConfig(orgId);
  const cfg = getConfig(orgId);
  sendJson(res, 200, {
    certificates: rows.map(c => certOut(c, emps.get(Number(c.employee_id)))),
    hireDates,
    config: { templates: cfg.templates, defaults: DEFAULT_TEMPLATES, nit: orgNit(orgId), city: sc.city, signer: sc.signer || orgAdminName(orgId), signerRole: sc.signerRole, signerSignature: sc.signerSignature },
  });
}

function findEmployee(orgId, id) { return db.prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(Number(id), orgId); }

// POST /api/certificates/draft { employeeId, addressedTo, includeSalary, includeFunctions, functionsText, hireDate }
async function draftCertificate(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const emp = findEmployee(orgId, body.employeeId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  const r = render(orgId, emp, readOpts(body));
  const missing = [];
  if (!r.snapshot.hireDate) missing.push('la fecha de ingreso');
  if (!emp.document_number) missing.push('el número de documento');
  if (!emp.role) missing.push('el cargo');
  if (readOpts(body).includeSalary && !(Number(emp.salary) > 0)) missing.push('el salario');
  sendJson(res, 200, { kind: r.kind, kindLabel: KIND_LABEL[r.kind], retired: r.retired, title: r.title, body: r.body, missing });
}

// POST /api/certificates { ...opciones, title, body } -> genera (numero consecutivo)
async function createCertificate(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const emp = findEmployee(orgId, body.employeeId);
  if (!emp) return sendJson(res, 404, { error: 'Colaborador no encontrado.' });
  const opts = readOpts(body);
  const r = render(orgId, emp, opts);
  const title = String(body.title || r.title).trim().slice(0, 200);
  const text = String(body.body || r.body).replace(/\r\n?/g, '\n').trim().slice(0, 20000);
  if (!title || text.length < 30) return sendJson(res, 400, { error: 'El texto del certificado está vacío.' });
  if (/\{\{\s*[a-z_]+\s*\}\}/.test(text)) return sendJson(res, 400, { error: 'El texto tiene variables sin reemplazar ({{...}}). Revísalo antes de generar.' });
  const today = todayISOInBogota();
  const year = Number(today.slice(0, 4));
  const id = uid('cert');
  let number = '';
  db.exec('BEGIN');
  try {
    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM work_certificates WHERE organization_id = ? AND year = ?').get(orgId, year) || {}).m || 0) + 1;
    number = `CL-${year}-${String(seq).padStart(4, '0')}`;
    const hash = sha256Hex(`${id}\n${number}\n${title}\n${text}\n${today}`);
    let code = hash.slice(0, 16).toUpperCase();
    if (db.prepare('SELECT 1 FROM work_certificates WHERE verify_code = ?').get(code)) code = hash.slice(16, 32).toUpperCase();
    db.prepare(`INSERT INTO work_certificates (id, organization_id, employee_id, year, seq, number, kind, addressed_to, include_salary, include_functions, title, body, data_json, issue_date, issued_by, doc_hash, verify_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, emp.id, year, seq, number, r.kind, opts.addressedTo || null, opts.includeSalary ? 1 : 0, opts.includeFunctions ? 1 : 0, title, text,
        JSON.stringify({ ...r.snapshot, functionsText: opts.includeFunctions ? opts.functionsText : '' }), today, req.user.id, hash, code);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nada */ } throw e; }
  logAction({ organizationId: orgId, userId: req.user.id, action: 'certificate.issue', resourceType: 'employee', resourceId: String(emp.id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, numero: number, tipo: KIND_LABEL[r.kind], dirigidoA: opts.addressedTo || 'A quien interese', conSalario: opts.includeSalary, conFunciones: opts.includeFunctions } });
  const row = db.prepare('SELECT c.*, u.email AS issued_by_email FROM work_certificates c LEFT JOIN users u ON u.id = c.issued_by WHERE c.id = ?').get(id);
  sendJson(res, 200, { ok: true, certificate: certOut(row, emp) });
}

// POST /api/certificates/:id/annul { reason }
async function annulCertificate(req, res, params) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const c = db.prepare('SELECT * FROM work_certificates WHERE id = ? AND organization_id = ?').get(String(params.id), orgId);
  if (!c) return sendJson(res, 404, { error: 'Certificado no encontrado.' });
  if (c.annulled_at) return sendJson(res, 409, { error: 'Ese certificado ya estaba anulado.' });
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (reason.length < 5) return sendJson(res, 400, { error: 'Escribe el motivo (mínimo 5 caracteres).' });
  db.prepare("UPDATE work_certificates SET annulled_at = datetime('now', '-5 hours'), annulled_by = ?, annul_reason = ? WHERE id = ?").run(req.user.id, reason, c.id);
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(c.employee_id) || {};
  logAction({ organizationId: orgId, userId: req.user.id, action: 'certificate.annul', resourceType: 'employee', resourceId: String(c.employee_id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, numero: c.number, motivo: reason } });
  sendJson(res, 200, { ok: true });
}

// POST /api/certificates/:id/link -> enlace para enviar por WhatsApp (vence en 30 dias)
async function certificateLink(req, res, params) {
  let body; try { body = await readBody(req); } catch { body = {}; }
  const orgId = resolveOrgId(req, body);
  const c = db.prepare('SELECT * FROM work_certificates WHERE id = ? AND organization_id = ?').get(String(params.id), orgId);
  if (!c) return sendJson(res, 404, { error: 'Certificado no encontrado.' });
  if (c.annulled_at) return sendJson(res, 409, { error: 'El certificado está anulado.' });
  const token = randomToken(24);
  const expires = addDaysISO(todayISOInBogota(), LINK_DAYS);
  db.prepare("UPDATE work_certificates SET token_hash = ?, token_expires = ?, sent_at = datetime('now', '-5 hours'), sent_by = ? WHERE id = ?").run(sha256Hex(token), expires, req.user.id, c.id);
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(c.employee_id) || {};
  logAction({ organizationId: orgId, userId: req.user.id, action: 'certificate.send', resourceType: 'employee', resourceId: String(c.employee_id), ip: getClientIp(req),
    metadata: { colaborador: emp.name, numero: c.number, vence: expires } });
  sendJson(res, 200, { ok: true, token, expires });
}

// PUT /api/certificates/config { templates }
async function saveCertificateConfig(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const orgId = resolveOrgId(req, body);
  const out = { templates: {} };
  for (const k of KINDS) {
    const tp = (body.templates || {})[k];
    if (tp && tp.body && String(tp.body).trim() !== DEFAULT_TEMPLATES[k].body.trim()) out.templates[k] = { title: String(tp.title || DEFAULT_TEMPLATES[k].title).slice(0, 200), body: String(tp.body).slice(0, 20000) };
  }
  db.prepare('UPDATE org_settings SET certificate_config = ? WHERE organization_id = ?').run(JSON.stringify(out), orgId);
  logAction({ organizationId: orgId, userId: req.user.id, action: 'certificate.config', resourceType: 'organization', resourceId: orgId, ip: getClientIp(req), metadata: { plantillasPropias: Object.keys(out.templates) } });
  sendJson(res, 200, { ok: true });
}

// ---- Publico (sin sesion) ---------------------------------------------------
// Limite sencillo por IP para la verificacion (evita probar codigos al azar).
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 600000) hits.delete(k);
  return h.length > 40;
}
function maskDoc(n) { const s = String(n || ''); return s.length > 4 ? '*'.repeat(Math.min(6, s.length - 4)) + s.slice(-4) : s; }
// GET /api/public/certificado/verificar/:code -> datos minimos para comprobar que es autentico
function publicVerify(req, res, params) {
  if (tooMany(getClientIp(req) || 'x')) return sendJson(res, 429, { error: 'Demasiadas consultas. Intenta de nuevo en unos minutos.' });
  const code = String(params.code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (code.length !== 16) return sendJson(res, 404, { error: 'El código no es válido.' });
  const c = db.prepare('SELECT * FROM work_certificates WHERE verify_code = ?').get(code);
  if (!c) return sendJson(res, 404, { error: 'No encontramos un certificado con ese código.' });
  let data = {}; try { data = JSON.parse(c.data_json || '{}') || {}; } catch { data = {}; }
  sendJson(res, 200, { valid: !c.annulled_at, annulled: !!c.annulled_at, annulledAt: c.annulled_at || '', org: orgName(c.organization_id), nit: orgNit(c.organization_id),
    number: c.number, kindLabel: KIND_LABEL[c.kind] || '', issueDate: c.issue_date, name: data.name || '', document: `${data.documentType || 'CC'} ${maskDoc(data.documentNumber)}` });
}
// GET /api/public/certificado/:token -> el certificado completo (enlace enviado al colaborador)
function publicCertificate(req, res, params) {
  const t = String(params.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) return sendJson(res, 404, { error: 'Este enlace no es válido.' });
  const c = db.prepare('SELECT * FROM work_certificates WHERE token_hash = ?').get(sha256Hex(t));
  if (!c || !c.token_expires || c.token_expires < todayISOInBogota()) return sendJson(res, 404, { error: 'Este enlace no es válido o ya venció. Pide uno nuevo a Recursos Humanos.' });
  const st = db.prepare('SELECT org_name, logo_base64 FROM org_settings WHERE organization_id = ?').get(c.organization_id) || {};
  if (c.annulled_at) return sendJson(res, 200, { annulled: true, org: st.org_name || '', nit: orgNit(c.organization_id), logo: st.logo_base64 || null, number: c.number });
  const sc = signerConfig(c.organization_id);
  sendJson(res, 200, { org: st.org_name || '', nit: orgNit(c.organization_id), logo: st.logo_base64 || null, number: c.number, title: c.title, body: c.body,
    issueDate: c.issue_date, signature: sc.signerSignature || '', verifyCode: verifyFormat(c.verify_code) });
}

module.exports = {
  listCertificates, draftCertificate, createCertificate, annulCertificate, certificateLink, saveCertificateConfig,
  publicVerify, publicCertificate, pesosEnLetras, numberToWords, DEFAULT_TEMPLATES,
};
