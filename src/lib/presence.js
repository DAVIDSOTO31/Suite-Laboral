'use strict';
// Presencia de las organizaciones (solo para el panel de Super Admin).
//
// - "En linea": la organizacion tiene pestanas de la suite abiertas ahora mismo
//   (conexiones de actualizacion en vivo, ver live.js).
// - "Ultima actividad": hora de la ultima peticion de cada usuario. Se guarda en
//   la base de datos como maximo una vez por minuto por usuario (para no cargar
//   el servidor) y asi no se pierde despues de un deploy.
const { db } = require('../db');

const memSeen = new Map();   // userId -> ms de la ultima actividad
const lastWrite = new Map(); // userId -> ms de la ultima escritura en la base
const WRITE_EVERY_MS = 60 * 1000;

function write(userId, now) {
  try {
    db.prepare('UPDATE users SET last_seen_at_ms = ? WHERE id = ?').run(now, userId);
    lastWrite.set(userId, now);
  } catch { /* la presencia nunca debe romper una peticion */ }
}

function touch(user) {
  if (!user || user.isSuperAdmin || !user.organizationId) return;
  const now = Date.now();
  memSeen.set(user.id, now);
  if (now - (lastWrite.get(user.id) || 0) >= WRITE_EVERY_MS) write(user.id, now);
}

// Al cerrar la pestana (fin de la conexion en vivo) se guarda la hora exacta.
function touchNow(userId) {
  if (!userId) return;
  const now = Date.now();
  memSeen.set(userId, now);
  write(userId, now);
}

// Ultima actividad (ms) de cualquier usuario de la organizacion, o null.
function orgLastSeen(orgId) {
  let max = null;
  for (const u of db.prepare('SELECT id, last_seen_at_ms FROM users WHERE organization_id = ?').all(orgId)) {
    const v = Math.max(Number(u.last_seen_at_ms) || 0, memSeen.get(u.id) || 0);
    if (v && (max === null || v > max)) max = v;
  }
  return max;
}

module.exports = { touch, touchNow, orgLastSeen };
