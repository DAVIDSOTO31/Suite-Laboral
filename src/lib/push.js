'use strict';
// ===========================================================================
// AVISOS AL CELULAR (Web Push) -- centro de notificaciones de la suite.
//
// - Sin dependencias externas: el cifrado (RFC 8291, aes128gcm) y la firma
//   VAPID (RFC 8292, ES256) se hacen con node:crypto.
// - Las claves VAPID se crean solas la primera vez y se guardan en la base de
//   datos (tabla push_kv), asi sobreviven reinicios y respaldos.
// - Reciben avisos los usuarios con permiso "attendance.view_alerts"
//   (Administrador y Supervisor) que activaron los avisos en su dispositivo.
// - Horario de silencio (hora Colombia): de 23:00 a 05:30 no se envian avisos;
//   al terminar el silencio llega UN resumen de lo ocurrido en la noche.
// - Las alertas que llegan casi al mismo tiempo se agrupan en un solo aviso.
// ===========================================================================
const crypto = require('node:crypto');
const { db, uid } = require('../db');
const env = require('./env');

// Tipos de alerta que se notifican (los 7 del submodulo de Alertas).
const NOTIFY_TYPES = ['llegada_tarde', 'exceso_almuerzo', 'salida_anticipada', 'inasistencia', 'turno_sin_cerrar', 'marcacion_manual', 'etapa_extendida', 'entorno_diferente'];
const TYPE_LABEL = {
  llegada_tarde: 'Llegada tarde', exceso_almuerzo: 'Exceso de almuerzo', salida_anticipada: 'Salida anticipada',
  inasistencia: 'No se presentó', turno_sin_cerrar: 'Turno sin cerrar', marcacion_manual: 'Marcación manual', etapa_extendida: 'Etapa extendida', entorno_diferente: 'Marcación sospechosa',
};
const QUIET_START_MIN = 23 * 60;      // 11:00 p. m.
const QUIET_END_MIN = 5 * 60 + 30;    // 5:30 a. m.
const BATCH_WAIT_MS = 4000;           // espera para agrupar alertas simultaneas

// Servicios de push conocidos (evita que el servidor haga peticiones a
// direcciones arbitrarias). PUSH_ALLOW_ANY_ENDPOINT=1 solo para pruebas locales.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.api\.chrome\.google\.com$/];
function endpointAllowed(endpoint) {
  try {
    const u = new URL(endpoint);
    if (process.env.PUSH_ALLOW_ANY_ENDPOINT === '1') return u.protocol === 'https:' || u.protocol === 'http:';
    return u.protocol === 'https:' && PUSH_HOSTS.some(re => re.test(u.hostname));
  } catch { return false; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS push_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '-5 hours')),
  last_ok_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS user_notification_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seen_until TEXT
);
`);

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function kvGet(key) { const r = db.prepare('SELECT value FROM push_kv WHERE key = ?').get(key); return r ? r.value : null; }
function kvSet(key, value) { db.prepare('INSERT INTO push_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

// ---- Claves VAPID (se crean una sola vez) ----
let vapidCache = null;
function vapidKeys() {
  if (vapidCache) return vapidCache;
  let jwk = null;
  try { jwk = JSON.parse(kvGet('vapid_private_jwk') || 'null'); } catch { jwk = null; }
  if (!jwk) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' });
    kvSet('vapid_private_jwk', JSON.stringify(jwk));
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicRaw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  vapidCache = { privateKey, publicKey: b64u(publicRaw) };
  return vapidCache;
}
function vapidSubject() {
  if (/^https:\/\//.test(env.APP_URL || '')) return env.APP_URL;
  return `mailto:${env.SUPERADMIN_EMAIL || 'admin@example.com'}`;
}
function vapidAuthHeader(endpoint) {
  const { privateKey, publicKey } = vapidKeys();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapidSubject() }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${publicKey}`;
}

// ---- Cifrado del mensaje (RFC 8291, aes128gcm) ----
function encryptPayload(subscription, plaintext) {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Envia un aviso a una suscripcion. Devuelve { ok, status, gone }.
async function sendToSubscription(sub, payloadObj) {
  if (!endpointAllowed(sub.endpoint)) return { ok: false, status: 0, gone: true };
  try {
    const body = encryptPayload(sub, JSON.stringify(payloadObj));
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm',
        TTL: '43200', Urgency: 'high', Authorization: vapidAuthHeader(sub.endpoint),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const ok = r.status >= 200 && r.status < 300;
    if (ok) db.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now', '-5 hours'), fail_count = 0 WHERE id = ?").run(sub.id);
    else if (r.status === 404 || r.status === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id); // el dispositivo ya no existe
    else {
      db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(sub.id);
      db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND fail_count >= 20').run(sub.id);
      console.error(`[avisos] El servicio de push respondió ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    }
    return { ok, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) {
    console.error('[avisos] No se pudo enviar el aviso:', e.message);
    return { ok: false, status: 0, gone: false };
  }
}

// Administradores y Supervisores (permiso attendance.view_alerts) activos de la organizacion.
function adminUserIds(orgId) {
  return db.prepare(`
    SELECT DISTINCT u.id FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE u.organization_id = ? AND u.status = 'active' AND p.code = 'attendance.view_alerts'
  `).all(orgId).map(r => r.id);
}
async function sendToOrgAdmins(orgId, payloadObj) {
  const ids = adminUserIds(orgId);
  if (!ids.length) return 0;
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE organization_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`).all(orgId, ...ids);
  const results = await Promise.all(subs.map(s => sendToSubscription(s, payloadObj)));
  return results.filter(r => r.ok).length;
}

// ---- Hora Colombia y horario de silencio ----
function bogotaParts(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (t) => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}
function isQuietTime(now = new Date()) {
  const { minutes } = bogotaParts(now);
  return minutes >= QUIET_START_MIN || minutes < QUIET_END_MIN;
}
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ---- Texto de cada alerta ----
function alertText(a) {
  let meta = {};
  try { meta = JSON.parse(a.metadata_json || '{}'); } catch { meta = {}; }
  const min = (n) => `${Math.abs(Number(n) || 0)} min`;
  const at = a.actual_time ? ` a las ${a.actual_time}` : '';
  switch (a.alert_type) {
    case 'llegada_tarde': return `Llegó ${min(a.diff_minutes)} tarde${at}.`;
    case 'exceso_almuerzo': return `Se excedió ${min(a.diff_minutes)} en el almuerzo${a.actual_time ? ` (regresó a las ${a.actual_time})` : ''}.`;
    case 'salida_anticipada': return `Salió ${min(a.diff_minutes)} antes de terminar la jornada${at}.`;
    case 'inasistencia': return `No marcó entrada en su turno${meta.turno ? ` de ${meta.turno}` : ''}.`;
    case 'turno_sin_cerrar': return `Marcó entrada pero no la salida${meta.turno ? ` del turno ${meta.turno}` : ''}.`;
    case 'marcacion_manual': return `Marcación manual${at}${meta.origen ? ` · ${meta.origen}` : ''}${meta.motivo ? ` · Motivo: ${meta.motivo}` : ''}.`;
    case 'etapa_extendida': return `${meta.etapa || 'Etapa del turno partido extendida'} (${min(a.diff_minutes)}).`;
    case 'entorno_diferente': return `Marcó${at} en un entorno diferente al de siempre${meta.dispositivo ? ` (kiosco ${meta.dispositivo})` : ''}. Revisa la foto.`;
    default: return 'Nueva alerta de asistencia.';
  }
}
// ---- Formato del aviso al celular (titulo con color + detalle ordenado) ----
const TYPE_DOT = {
  llegada_tarde: '🔴', salida_anticipada: '🟠', exceso_almuerzo: '🟡', inasistencia: '⚫',
  turno_sin_cerrar: '🟤', marcacion_manual: '🔵', entorno_diferente: '🟣', etapa_extendida: '⚪',
};
const MARK_LABEL = { entrada: 'Entrada', inicio_almuerzo: 'Inicio de almuerzo', fin_almuerzo: 'Fin de almuerzo', salida: 'Salida' };
// "CLAUDIA LORENA VILLADA" -> "Claudia Lorena Villada"
function niceName(n) {
  const s = String(n || '').trim();
  if (s !== s.toUpperCase()) return s || 'Colaborador'; // ya viene escrito con mayusculas y minusculas
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase()).trim() || 'Colaborador';
}
// "14:57" -> "2:57 p. m."
function clock12(hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ''));
  if (!m) return hm || '';
  const h = Number(m[1]) % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
function turno12(t) { return String(t || '').split(/\s*-\s*/).map(clock12).join(' – '); }
function alertMeta(a) { try { return JSON.parse(a.metadata_json || '{}') || {}; } catch { return {}; } }
// Lo que paso, en pocas palabras (va despues del nombre).
function alertHeadline(a) {
  const meta = alertMeta(a);
  const min = `${Math.abs(Number(a.diff_minutes) || 0)} min`;
  switch (a.alert_type) {
    case 'llegada_tarde': return `llegó ${min} tarde`;
    case 'salida_anticipada': return `salió ${min} antes`;
    case 'exceso_almuerzo': return `se excedió ${min} en el almuerzo`;
    case 'inasistencia': return 'no se presentó';
    case 'turno_sin_cerrar': return 'no marcó la salida';
    case 'marcacion_manual': return `marcación manual${meta.markType ? ` (${(MARK_LABEL[meta.markType] || meta.markType).toLowerCase()})` : ''}`;
    case 'etapa_extendida': return `extendió una etapa ${min}`;
    case 'entorno_diferente': return 'marcación sospechosa';
    default: return 'nueva alerta';
  }
}
// Detalle: horas de la marcacion y del turno.
// "Juan Pérez llegó 12 min tarde" / "Juan Pérez · marcación manual"
function nameAndHeadline(a) {
  const h = alertHeadline(a);
  return `${niceName(a.employee_name)}${/^marcaci/.test(h) ? ' · ' : ' '}${h}`;
}
function alertDetail(a) {
  const meta = alertMeta(a);
  const act = clock12(a.actual_time), sch = clock12(a.scheduled_time);
  switch (a.alert_type) {
    case 'llegada_tarde': return `Marcó entrada a las ${act}${sch ? ` · turno desde las ${sch}` : ''}`;
    case 'salida_anticipada': return `Marcó salida a las ${act}${sch ? ` · turno hasta las ${sch}` : ''}`;
    case 'exceso_almuerzo': return a.actual_time ? `Regresó del almuerzo a las ${act}` : 'Se excedió en el almuerzo';
    case 'inasistencia': return meta.turno ? `Turno ${turno12(meta.turno)}, sin ninguna marcación` : 'Sin ninguna marcación en su turno';
    case 'turno_sin_cerrar': return `${meta.entrada ? `Entró a las ${clock12(meta.entrada)}` : 'Marcó entrada'}${meta.turno ? ` · turno ${turno12(meta.turno)}` : ''}`;
    case 'marcacion_manual': return `${a.actual_time ? `A las ${act}` : 'Marcación manual'}${meta.origen ? ` · ${meta.origen}` : ''}${meta.motivo ? `\nMotivo: ${meta.motivo}` : ''}`;
    case 'etapa_extendida': return meta.etapa || 'Etapa del turno partido extendida';
    case 'entorno_diferente': return `Marcó${a.actual_time ? ` a las ${act}` : ''} en un entorno diferente${meta.dispositivo ? ` (${meta.dispositivo})` : ''}. Revisa la foto.`;
    default: return alertText(a);
  }
}
function alertRowFull(alertId) {
  return db.prepare(`SELECT a.*, e.name AS employee_name, COALESCE(e.department, 'Sin área') AS department
    FROM attendance_alerts a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`).get(alertId);
}

// ---- Cola: agrupa alertas simultaneas en un solo aviso por organizacion ----
const queues = new Map(); // orgId -> { ids: [], timer }
function onAlertCreated(orgId, alertId, alertType, shiftDate) {
  if (!NOTIFY_TYPES.includes(alertType)) return;
  // Solo alertas recientes (la revision automatica mira hasta 3 dias atras).
  const { date } = bogotaParts();
  if (shiftDate < addDays(date, -1)) return;
  if (!queues.has(orgId)) queues.set(orgId, { ids: [], timer: null });
  const q = queues.get(orgId);
  q.ids.push(alertId);
  if (!q.timer) {
    q.timer = setTimeout(() => { flushQueue(orgId).catch(e => console.error('[avisos]', e.message)); }, BATCH_WAIT_MS);
    if (q.timer.unref) q.timer.unref();
  }
}
async function flushQueue(orgId, now = new Date()) {
  const q = queues.get(orgId);
  if (!q) return;
  queues.delete(orgId);
  if (isQuietTime(now)) return; // quedan en la campana; el resumen sale a las 5:30 a. m.
  const rows = q.ids.map(alertRowFull).filter(Boolean);
  if (!rows.length) return;
  if (rows.length === 1) {
    const a = rows[0];
    await sendToOrgAdmins(orgId, {
      title: `${TYPE_DOT[a.alert_type] || '🔔'} ${nameAndHeadline(a)}`,
      body: `${alertDetail(a)}\nÁrea: ${a.department}`,
      tag: `alerta-${a.id}`,
      url: `/app.html#alerta=${encodeURIComponent(a.id)}`,
      actions: [{ action: 'ver', title: 'Ver alerta' }],
    });
  } else if (new Set(rows.map(a => a.employee_id)).size === 1) {
    // Varias alertas de la MISMA persona (ej. llegada tarde + marcacion manual).
    const a0 = rows[0];
    await sendToOrgAdmins(orgId, {
      title: `${[...new Set(rows.map(a => TYPE_DOT[a.alert_type] || '🔔'))].join('')} ${niceName(a0.employee_name)}: ${rows.length} alertas`,
      body: `${rows.map(a => `${TYPE_DOT[a.alert_type] || '🔔'} ${alertHeadline(a).replace(/^./, c => c.toUpperCase())} · ${alertDetail(a).split('\n')[0]}`).join('\n')}\nÁrea: ${a0.department}`,
      tag: `alerta-${a0.id}`,
      url: `/app.html#alerta=${encodeURIComponent(a0.id)}`,
      actions: [{ action: 'ver', title: 'Ver alerta' }],
    });
  } else {
    // Una linea por alerta (maximo 6; el resto se resume).
    const MAX_LINES = 6;
    const lines = rows.slice(0, MAX_LINES).map(a => `${TYPE_DOT[a.alert_type] || '🔔'} ${niceName(a.employee_name)} · ${alertHeadline(a)} (${a.department})`);
    if (rows.length > MAX_LINES) lines.push(`… y ${rows.length - MAX_LINES} más`);
    await sendToOrgAdmins(orgId, {
      title: `${rows.length} alertas de asistencia`,
      body: lines.join('\n'),
      tag: `alertas-${Date.now()}`,
      url: '/app.html#alertas',
      actions: [{ action: 'ver', title: 'Ver alertas' }],
    });
  }
}

// ---- Resumen al terminar el horario de silencio (5:30 a. m.) ----
async function quietSummaryTick(now = new Date()) {
  const { date, minutes } = bogotaParts(now);
  if (minutes < QUIET_END_MIN || minutes >= QUIET_END_MIN + 60) return; // entre 5:30 y 6:30 a. m.
  const orgs = db.prepare('SELECT DISTINCT organization_id AS id FROM push_subscriptions').all();
  for (const o of orgs) {
    const key = `quiet_summary:${o.id}`;
    if (kvGet(key) === date) continue;
    kvSet(key, date);
    const from = `${addDays(date, -1)} 23:00:00`, to = `${date} 05:30:00`;
    const rows = db.prepare(`SELECT alert_type, COUNT(*) AS n FROM attendance_alerts
      WHERE organization_id = ? AND created_at >= ? AND created_at < ? AND alert_type IN (${NOTIFY_TYPES.map(() => '?').join(',')})
      GROUP BY alert_type`).all(o.id, from, to, ...NOTIFY_TYPES);
    const total = rows.reduce((s, r) => s + r.n, 0);
    if (!total) continue;
    await sendToOrgAdmins(o.id, {
      title: `Resumen de la noche: ${total} alerta${total === 1 ? '' : 's'}`,
      body: `${rows.map(r => `${r.n} ${(TYPE_LABEL[r.alert_type] || r.alert_type).toLowerCase()}`).join(' · ')}. Entre las 11:00 p. m. y las 5:30 a. m.`,
      tag: `resumen-${date}`,
      url: '/app.html#alertas',
    });
  }
}
const summaryTimer = setInterval(() => { quietSummaryTick().catch(e => console.error('[avisos]', e.message)); }, 60 * 1000);
if (summaryTimer.unref) summaryTimer.unref();

module.exports = {
  NOTIFY_TYPES, TYPE_LABEL, QUIET_START_MIN, QUIET_END_MIN,
  vapidKeys, endpointAllowed, encryptPayload, sendToSubscription, sendToOrgAdmins,
  onAlertCreated, flushQueue, quietSummaryTick, isQuietTime, bogotaParts, alertText,
};
