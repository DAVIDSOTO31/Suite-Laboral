'use strict';
// Actualizacion en vivo por organizacion.
//
// Cada pestana abierta de la suite mantiene una conexion "Server-Sent Events"
// (GET /api/org/live). Cuando alguien de la MISMA organizacion guarda un
// cambio, el servidor avisa a las demas pestanas cual parte cambio (datos,
// asistencia, liquidacion, usuarios) y ellas se actualizan solas, sin
// recargar la pagina. Nunca se envian datos por este canal: solo el aviso;
// cada pestana pide luego lo que necesita con sus propios permisos.
//
// El kiosco no usa este canal: consulta cada pocos segundos un contador
// liviano (dataSeq) y recarga su lista si cambio.

const subscribers = new Map(); // orgId -> Set<{ res, userId, clientId }>
const dataSeq = new Map();     // orgId -> contador de cambios de "datos" (turnos, colaboradores, ajustes)
let nextId = 1;

// Ambito de cada ruta que modifica informacion. Lo que no aparece aqui no se avisa.
const SCOPE_RULES = [
  [/^\/api\/org\/(sync|seed-demo|settings|departments|shift-presets|rotation-patterns|data-retention)$/, ['data']],
  [/^\/api\/org\/day-zero$/, ['data', 'payroll']],
  [/^\/api\/shifts\/publish$/, ['data']],
  [/^\/api\/employees\/[^/]+\/(retire|reactivate|delete-permanent)$/, ['data', 'users']],
  [/^\/api\/payroll\/opening-balance/, ['data', 'payroll']],
  [/^\/api\/payroll\//, ['payroll']],
  [/^\/api\/org\/users/, ['users', 'data']],
  [/^\/api\/attendance\/(mark|mark-by-face|corrections|alerts\/[^/]+\/manage|offline-marks\/[^/]+\/(apply|discard))$/, ['attendance']],
  [/^\/api\/attendance\/(devices|face-profiles|evidence-settings|device-alert-settings|indicator-goals|digest-settings)/, ['attendance']],
];
function scopesForPath(pathname) {
  for (const [re, scopes] of SCOPE_RULES) if (re.test(pathname)) return scopes;
  return null;
}

function subscribe(orgId, res, meta) {
  if (!subscribers.has(orgId)) subscribers.set(orgId, new Set());
  const sub = { id: nextId++, res, userId: meta.userId, clientId: meta.clientId || null };
  subscribers.get(orgId).add(sub);
  return () => {
    const set = subscribers.get(orgId);
    if (set) { set.delete(sub); if (!set.size) subscribers.delete(orgId); }
  };
}

// Avisa a la organizacion. event: { scopes:[], by (email), userId, clientId, kind }
function publish(orgId, event) {
  if (!orgId || !event || !Array.isArray(event.scopes) || !event.scopes.length) return;
  if (event.scopes.includes('data')) dataSeq.set(orgId, (dataSeq.get(orgId) || 0) + 1);
  const set = subscribers.get(orgId);
  if (!set || !set.size) return;
  const payload = `event: change\ndata: ${JSON.stringify({ scopes: event.scopes, by: event.by || null, userId: event.userId || null, clientId: event.clientId || null, kind: event.kind || null, at: Date.now() })}\n\n`;
  for (const sub of set) {
    try { sub.res.write(payload); } catch { /* conexion cerrada: se limpia al cerrar */ }
  }
}

// Avisos de asistencia muy seguidos (varias marcaciones por minuto) se
// agrupan: uno cada 3 segundos como maximo por organizacion.
const attTimers = new Map();
function publishAttendance(orgId, kind) {
  if (!orgId || attTimers.has(orgId)) return;
  attTimers.set(orgId, setTimeout(() => {
    attTimers.delete(orgId);
    publish(orgId, { scopes: ['attendance'], kind: kind || 'attendance' });
  }, 3000));
}

function getDataSeq(orgId) { return dataSeq.get(orgId) || 0; }

// Latido cada 25 s: mantiene viva la conexion a traves de proxies.
const beat = setInterval(() => {
  for (const set of subscribers.values()) for (const sub of set) { try { sub.res.write(': latido\n\n'); } catch { /* nada */ } }
}, 25000);
if (beat.unref) beat.unref();

function stats() {
  let n = 0;
  for (const set of subscribers.values()) n += set.size;
  return { orgs: subscribers.size, connections: n };
}

// Pestanas abiertas ahora mismo en la organizacion (y cuantos usuarios distintos).
function orgPresence(orgId) {
  const set = subscribers.get(orgId);
  if (!set || !set.size) return { connections: 0, users: 0 };
  return { connections: set.size, users: new Set([...set].map(s => s.userId)).size };
}

module.exports = { orgPresence, subscribe, publish, publishAttendance, scopesForPath, getDataSeq, stats };
