'use strict';
// ===========================================================================
// CENTRO DE NOTIFICACIONES (campana) -- solo Administrador (settings.manage).
// Muestra las alertas de Asistencia de los ultimos dias y administra los
// avisos al celular (Web Push) de cada dispositivo del administrador.
// ===========================================================================
const { db, uid } = require('../db');
const { sendJson, readBody } = require('../lib/http');
const push = require('../lib/push');

const DAYS_BACK = 14;
const MAX_ITEMS = 40;

function bogotaNowSql() { return db.prepare("SELECT datetime('now', '-5 hours') AS n").get().n; }

// GET /api/notifications
function listNotifications(req, res) {
  const orgId = req.user.organizationId;
  if (!orgId) return sendJson(res, 400, { error: 'No hay organizacion asociada a esta cuenta.' });
  const since = db.prepare(`SELECT datetime('now', '-5 hours', '-${DAYS_BACK} days') AS s`).get().s;
  const types = push.NOTIFY_TYPES;
  const rows = db.prepare(`
    SELECT a.id, a.alert_type, a.employee_id, a.shift_date, a.actual_time, a.diff_minutes, a.metadata_json, a.created_at,
           e.name AS employee_name, COALESCE(e.department, 'Sin área') AS department, COALESCE(m.status, 'pendiente') AS mgmt
    FROM attendance_alerts a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN alert_management m ON m.alert_id = a.id
    WHERE a.organization_id = ? AND a.created_at >= ? AND a.alert_type IN (${types.map(() => '?').join(',')})
    ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(orgId, since, ...types, MAX_ITEMS);
  const st = db.prepare('SELECT seen_until FROM user_notification_state WHERE user_id = ?').get(req.user.id);
  const seenUntil = (st && st.seen_until) || null;
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM attendance_alerts
    WHERE organization_id = ? AND created_at >= ? AND alert_type IN (${types.map(() => '?').join(',')})${seenUntil ? ' AND created_at > ?' : ''}`)
    .get(orgId, since, ...types, ...(seenUntil ? [seenUntil] : [])).n;
  sendJson(res, 200, {
    items: rows.map(r => ({
      id: r.id, type: r.alert_type, label: push.TYPE_LABEL[r.alert_type] || r.alert_type,
      employeeId: r.employee_id, employeeName: r.employee_name, department: r.department,
      date: r.shift_date, createdAt: r.created_at, mgmt: r.mgmt,
      text: push.alertText(r), unread: !seenUntil || r.created_at > seenUntil,
    })),
    unread, seenUntil, now: bogotaNowSql(),
    quiet: { from: '23:00', to: '05:30', active: push.isQuietTime() },
  });
}

// POST /api/notifications/seen  -> marca como vistas todas las alertas hasta ahora
async function markSeen(req, res) {
  const now = bogotaNowSql();
  db.prepare(`INSERT INTO user_notification_state (user_id, seen_until) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET seen_until = excluded.seen_until`).run(req.user.id, now);
  sendJson(res, 200, { ok: true, seenUntil: now });
}

// GET /api/push/key
function publicKey(req, res) {
  sendJson(res, 200, { publicKey: push.vapidKeys().publicKey });
}

// POST /api/push/subscribe { endpoint, keys: { p256dh, auth } }
async function subscribe(req, res) {
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const endpoint = String(body.endpoint || '');
  const keys = body.keys || {};
  const p256dh = String(keys.p256dh || ''), auth = String(keys.auth || '');
  if (!endpoint || endpoint.length > 1000 || !push.endpointAllowed(endpoint)) return sendJson(res, 400, { error: 'Este dispositivo no tiene un servicio de avisos compatible.' });
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,30}$/.test(auth)) return sendJson(res, 400, { error: 'Datos de suscripción inválidos.' });
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET organization_id = ?, user_id = ?, p256dh = ?, auth = ?, user_agent = ?, fail_count = 0 WHERE id = ?')
      .run(req.user.organizationId, req.user.id, p256dh, auth, ua, existing.id);
  } else {
    db.prepare('INSERT INTO push_subscriptions (id, organization_id, user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uid('push'), req.user.organizationId, req.user.id, endpoint, p256dh, auth, ua);
  }
  sendJson(res, 200, { ok: true });
}

// POST /api/push/unsubscribe { endpoint }
async function unsubscribe(req, res) {
  let body;
  try { body = await readBody(req); } catch { body = {}; }
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(body.endpoint || ''), req.user.id);
  sendJson(res, 200, { ok: true });
}

// POST /api/push/test { endpoint }  -> aviso de prueba a ESTE dispositivo
async function sendTest(req, res) {
  let body;
  try { body = await readBody(req); } catch { body = {}; }
  const sub = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(String(body.endpoint || ''), req.user.id);
  if (!sub) return sendJson(res, 404, { error: 'Este dispositivo no tiene los avisos activados.' });
  const r = await push.sendToSubscription(sub, {
    title: 'Avisos activados ✅',
    body: 'Así te llegarán las alertas de Asistencia. Silencio de 11:00 p. m. a 5:30 a. m.',
    tag: 'prueba', url: '/app.html#alertas',
  });
  if (!r.ok) return sendJson(res, 502, { error: r.gone ? 'El dispositivo ya no acepta avisos. Vuelve a activarlos.' : `El servicio de avisos no respondió (código ${r.status}). Intenta de nuevo.` });
  sendJson(res, 200, { ok: true });
}

module.exports = { listNotifications, markSeen, publicKey, subscribe, unsubscribe, sendTest };
