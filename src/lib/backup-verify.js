'use strict';
// Verificacion de la copia de seguridad en la nube (Litestream -> Cloudflare R2).
//
// Restaura la copia de la nube en un archivo TEMPORAL aparte, revisa que no
// este danada (PRAGMA integrity_check) y compara cuantos registros tiene cada
// tabla importante contra la base real. Nunca toca la base de datos real: la
// copia restaurada se abre en solo lectura y se borra al terminar.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { db } = require('../db');

const CONFIG_PATH = process.env.LITESTREAM_CONFIG || '/etc/litestream.yml';
const RESTORE_TIMEOUT_MS = 3 * 60 * 1000;

// Tablas que se comparan (en el orden en que se muestran).
const TABLES = [
  ['organizations', 'Organizaciones'],
  ['users', 'Usuarios (incluye Super Admin)'],
  ['employees', 'Colaboradores'],
  ['shifts', 'Turnos'],
  ['shift_publications', 'Publicaciones de turnos'],
  ['attendance_marks', 'Marcaciones'],
  ['attendance_days', 'Días de asistencia'],
  ['attendance_alerts', 'Alertas de asistencia'],
  ['payroll_closures', 'Cierres de liquidación'],
  ['payroll_adjustments', 'Ajustes de liquidación'],
  ['audit_logs', 'Registros de auditoría'],
];
// Tablas que cambian a cada rato: una diferencia minima ahi es normal
// (cambios hechos mientras se verificaba la copia).
const BUSY_TABLES = new Set(['audit_logs', 'attendance_marks', 'attendance_days', 'attendance_alerts']);

let running = false;

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Solo la primera linea util del error (nunca variables de entorno ni claves).
        const detail = String(stderr || err.message || '').split('\n').map(s => s.trim()).filter(Boolean).slice(-1)[0] || 'error desconocido';
        const e = new Error(err.code === 'ENOENT' ? 'No se encontró el programa de copias (litestream) en este servidor.' : detail.slice(0, 300));
        e.code = err.code; e.killed = err.killed;
        return reject(e);
      }
      resolve(String(stdout || ''));
    });
  });
}

function countRows(conn) {
  const out = {};
  for (const [t] of TABLES) {
    try { out[t] = Number(conn.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c); }
    catch { out[t] = null; } // la tabla no existe en esta base
  }
  return out;
}

function liveDbPath() {
  const row = db.prepare('PRAGMA database_list').all().find(r => r.name === 'main');
  return row && row.file ? row.file : null;
}

function removeQuiet(file) {
  for (const f of [file, file + '-wal', file + '-shm', file + '.tmp']) {
    try { fs.unlinkSync(f); } catch { /* no existe */ }
  }
}

// Devuelve el resultado de la verificacion (nunca lanza: los errores vienen en el resultado).
async function verifyBackup() {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ok: false, configured: false, checkedAt, message: 'La copia en la nube no está configurada en este servidor (no hay configuración de Litestream). Esto es normal en un entorno de pruebas.' };
  }
  const dbPath = liveDbPath();
  if (!dbPath) return { ok: false, configured: true, checkedAt, message: 'No se pudo ubicar la base de datos de la suite.' };
  if (running) return { ok: false, configured: true, busy: true, checkedAt, message: 'Ya hay una verificación en curso. Espera a que termine.' };
  running = true;
  const tmpFile = path.join(os.tmpdir(), `verificacion-copia-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    // 1) Archivos de la copia en la nube (para saber cuando fue la ultima subida).
    let latestUploadAt = null, files = 0;
    try {
      const list = JSON.parse(await run('litestream', ['ltx', '-config', CONFIG_PATH, '-level', 'all', '-json', dbPath], 60000) || '[]');
      if (Array.isArray(list)) {
        files = list.length;
        for (const f of list) if (f && f.timestamp && (!latestUploadAt || f.timestamp > latestUploadAt)) latestUploadAt = f.timestamp;
      }
    } catch { /* solo informativo */ }

    // 2) Restaurar la copia de la nube en un archivo aparte.
    try {
      await run('litestream', ['restore', '-config', CONFIG_PATH, '-o', tmpFile, dbPath], RESTORE_TIMEOUT_MS);
    } catch (e) {
      if (/no matching backup files|no backups? found/i.test(e.message)) {
        return { ok: false, configured: true, checkedAt, durationMs: Date.now() - started, latestUploadAt, files, message: 'La nube no tiene ninguna copia de la base de datos todavía. Revisa las variables de Litestream en Render.' };
      }
      return { ok: false, configured: true, checkedAt, durationMs: Date.now() - started, latestUploadAt, files,
        message: e.killed ? 'La restauración tardó demasiado (más de 3 minutos) y se canceló.' : `No se pudo restaurar la copia desde la nube: ${e.message}` };
    }
    if (!fs.existsSync(tmpFile)) {
      return { ok: false, configured: true, checkedAt, durationMs: Date.now() - started, latestUploadAt, files, message: 'La nube no tiene ninguna copia de la base de datos todavía.' };
    }
    const sizeBytes = fs.statSync(tmpFile).size;

    // 3) Revisar la copia restaurada (solo lectura) y contar registros.
    let integrity = 'desconocido', backupCounts = {};
    const copy = new DatabaseSync(tmpFile, { readOnly: true });
    try {
      integrity = String(copy.prepare('PRAGMA integrity_check').get().integrity_check || '');
      backupCounts = countRows(copy);
    } finally { copy.close(); }
    const liveCounts = countRows(db);

    const tables = TABLES.map(([t, label]) => {
      const live = liveCounts[t], backup = backupCounts[t];
      let status = 'igual';
      if (live === null && backup === null) status = 'no_aplica';
      else if (live !== backup) status = (BUSY_TABLES.has(t) && live !== null && backup !== null && Math.abs(live - backup) <= 20) ? 'reciente' : 'diferente';
      return { table: t, label, live, backup, status };
    }).filter(r => r.status !== 'no_aplica');

    const integrityOk = integrity.toLowerCase() === 'ok';
    const different = tables.filter(r => r.status === 'diferente');
    const recent = tables.filter(r => r.status === 'reciente');
    const ok = integrityOk && different.length === 0;
    let message;
    if (!integrityOk) message = 'La copia restaurada presenta daños. Revisa los registros del servidor y contacta soporte técnico.';
    else if (different.length) message = `La copia no coincide en: ${different.map(r => r.label).join(', ')}. Vuelve a verificar en un minuto; si se repite, revisa los registros del servidor.`;
    else if (recent.length) message = 'La copia está completa. Hay diferencias mínimas por cambios hechos en los últimos segundos (marcaciones o auditoría), lo cual es normal.';
    else message = 'La copia en la nube está completa y coincide con la base de datos actual.';

    return { ok, configured: true, checkedAt, durationMs: Date.now() - started, latestUploadAt, files, sizeBytes, integrity: integrityOk ? 'ok' : integrity.slice(0, 200), tables, message };
  } finally {
    removeQuiet(tmpFile);
    running = false;
  }
}

module.exports = { verifyBackup };
