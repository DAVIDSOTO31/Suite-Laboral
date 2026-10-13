'use strict';
// Evidencia de las marcaciones del kiosco.
//
// 1) FOTO DE EVIDENCIA: una miniatura (WebP o JPEG de ~10 KB) por marcacion,
//    en una tabla aparte (mark_photos). Se borra sola a los 30 dias.
// 2) ENTORNO DIFERENTE: el kiosco envia una "firma" del fondo (96 numeros,
//    sin la zona de la persona). Cada dispositivo aprende como se ve su lugar
//    durante sus primeras marcaciones; despues, si el fondo de una marcacion
//    no se parece, se crea la alerta "entorno_diferente" (la marcacion se
//    registra igual).
// Cada organizacion puede apagar cualquiera de las dos en Usuarios & Seguridad.
const { db, uid } = require('../db');

const PHOTO_DAYS = 30;
const MAX_PHOTO_BYTES = 80 * 1024;
const PHOTO_MIMES = { 'image/webp': 'webp', 'image/jpeg': 'jpg' };

// Aprendizaje del entorno: se necesitan al menos ENV_LEARN_MARKS marcaciones
// en ENV_LEARN_DAYS dias distintos antes de empezar a alertar.
const ENV_LEARN_MARKS = 15;
const ENV_LEARN_DAYS = 2;
const ENV_MAX_REFS = 16;
const ENV_NEW_REF = 0.12;   // distancia minima para guardar una referencia nueva (variedad de luz)
const ENV_ALERT = 0.55;     // distancia a partir de la cual el fondo "no se parece"

db.exec(`
CREATE TABLE IF NOT EXISTS mark_photos (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  device_id TEXT,
  employee_id INTEGER,
  mark_id TEXT,
  offline_id TEXT,
  shift_date TEXT,
  mark_type TEXT,
  method TEXT,
  taken_at TEXT NOT NULL DEFAULT (datetime('now')),
  mime TEXT,
  bytes INTEGER,
  data BLOB,
  env_status TEXT,
  env_distance REAL
);
CREATE INDEX IF NOT EXISTS idx_mark_photos_emp_day ON mark_photos(organization_id, employee_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_mark_photos_mark ON mark_photos(mark_id);
CREATE INDEX IF NOT EXISTS idx_mark_photos_offline ON mark_photos(offline_id);
CREATE INDEX IF NOT EXISTS idx_mark_photos_taken ON mark_photos(taken_at);
`);
const setCols = db.prepare('PRAGMA table_info(org_settings)').all().map(c => c.name);
if (!setCols.includes('evidence_photo')) db.exec('ALTER TABLE org_settings ADD COLUMN evidence_photo INTEGER NOT NULL DEFAULT 1');
if (!setCols.includes('evidence_env')) db.exec('ALTER TABLE org_settings ADD COLUMN evidence_env INTEGER NOT NULL DEFAULT 1');
const devCols = db.prepare('PRAGMA table_info(attendance_devices)').all().map(c => c.name);
if (!devCols.includes('env_refs')) db.exec('ALTER TABLE attendance_devices ADD COLUMN env_refs TEXT');
if (!devCols.includes('env_learn_count')) db.exec('ALTER TABLE attendance_devices ADD COLUMN env_learn_count INTEGER NOT NULL DEFAULT 0');
if (!devCols.includes('env_learn_days')) db.exec('ALTER TABLE attendance_devices ADD COLUMN env_learn_days TEXT');

function getSettings(orgId) {
  const r = db.prepare('SELECT evidence_photo, evidence_env FROM org_settings WHERE organization_id = ?').get(orgId);
  return { photo: r ? r.evidence_photo !== 0 : true, env: r ? r.evidence_env !== 0 : true, days: PHOTO_DAYS };
}
function setSettings(orgId, { photo, env }) {
  const cur = getSettings(orgId);
  const p = photo == null ? cur.photo : !!photo, e = env == null ? cur.env : !!env;
  const exists = db.prepare('SELECT 1 FROM org_settings WHERE organization_id = ?').get(orgId);
  if (exists) db.prepare('UPDATE org_settings SET evidence_photo = ?, evidence_env = ? WHERE organization_id = ?').run(p ? 1 : 0, e ? 1 : 0, orgId);
  else db.prepare('INSERT INTO org_settings (organization_id, evidence_photo, evidence_env) VALUES (?, ?, ?)').run(orgId, p ? 1 : 0, e ? 1 : 0);
  return getSettings(orgId);
}

// ---- Firma del entorno ----
function validSignature(s) {
  if (!s || s.v !== 1 || !Array.isArray(s.m) || !Array.isArray(s.g) || s.m.length !== 48 || s.g.length !== 48) return false;
  const ok = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100);
  return s.m.every(ok) && s.g.every(ok) && s.m.filter(v => v !== null).length >= 12;
}
// 0 = identico. Compara solo los cuadros visibles en las dos firmas.
function envDistance(a, b) {
  let sm = 0, sg = 0, n = 0;
  for (let i = 0; i < 48; i++) {
    if (a.m[i] == null || b.m[i] == null) continue;
    sm += Math.abs(a.m[i] - b.m[i]);
    sg += Math.abs((a.g[i] || 0) - (b.g[i] || 0));
    n++;
  }
  if (n < 12) return null;
  return Math.round(((sm / n) * 0.6 + (sg / n) * 0.4) * 1000) / 1000;
}

function deviceEnvState(device) {
  let refs = [];
  try { refs = JSON.parse(device.env_refs || '[]'); } catch { refs = []; }
  let days = [];
  try { days = JSON.parse(device.env_learn_days || '[]'); } catch { days = []; }
  const count = Number(device.env_learn_count) || 0;
  const learned = count >= ENV_LEARN_MARKS && days.length >= ENV_LEARN_DAYS && refs.length > 0;
  return { refs, days, count, learned };
}
function envStatusForDevice(device) {
  const s = deviceEnvState(device);
  return { learned: s.learned, marks: s.count, marksNeeded: ENV_LEARN_MARKS, days: s.days.length, daysNeeded: ENV_LEARN_DAYS, refs: s.refs.length };
}

// Evalua la firma contra lo aprendido por el dispositivo y actualiza su
// aprendizaje. Devuelve { status: 'aprendiendo'|'normal'|'diferente', distance }.
function evaluateEnv(device, sig, dayISO) {
  const fresh = db.prepare('SELECT * FROM attendance_devices WHERE id = ?').get(device.id) || device;
  const st = deviceEnvState(fresh);
  let best = null;
  for (const r of st.refs) {
    const d = envDistance(sig, r.s);
    if (d != null && (best == null || d < best)) best = d;
  }
  let status;
  if (!st.learned) status = 'aprendiendo';
  else status = best != null && best > ENV_ALERT ? 'diferente' : 'normal';

  // Aprendizaje: durante el periodo inicial se guarda la variedad del lugar
  // (manana, tarde, noche). Despues solo se suman fondos muy parecidos, para
  // adaptarse a cambios pequenos sin "aprender" un lugar distinto.
  const refs = st.refs.slice();
  const addRef = st.learned ? (best != null && best > ENV_NEW_REF && best < ENV_ALERT * 0.6) : (best == null || best > ENV_NEW_REF);
  if (addRef) {
    refs.push({ s: { v: 1, m: sig.m, g: sig.g }, at: new Date().toISOString() });
    while (refs.length > ENV_MAX_REFS) refs.splice(st.learned ? 0 : 1, 1); // conserva la primera referencia mientras aprende
  }
  const days = st.days.includes(dayISO) ? st.days : st.days.concat([dayISO]).slice(-10);
  const count = st.learned ? st.count : st.count + 1;
  db.prepare('UPDATE attendance_devices SET env_refs = ?, env_learn_count = ?, env_learn_days = ? WHERE id = ?')
    .run(JSON.stringify(refs), count, JSON.stringify(days), device.id);
  return { status, distance: best };
}
function resetEnv(deviceId) {
  db.prepare("UPDATE attendance_devices SET env_refs = NULL, env_learn_count = 0, env_learn_days = NULL WHERE id = ?").run(deviceId);
}

// ---- Foto ----
function decodePhoto(dataUrl) {
  const m = /^data:(image\/(?:webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) return null;
  // Revisa la "firma" real del archivo (no solo lo que dice el texto).
  const isWebp = buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if ((m[1] === 'image/webp' && !isWebp) || (m[1] === 'image/jpeg' && !isJpeg)) return null;
  return { mime: m[1], buf };
}

// Guarda la evidencia de una marcacion. ctx: { device, employeeId, markId,
// offlineId, shiftDate, markType, method, takenAt }. Devuelve { saved, env }.
// Nunca lanza: la evidencia jamas debe impedir una marcacion.
function saveEvidence(ctx, evidence) {
  try {
    if (!evidence || typeof evidence !== 'object' || !ctx.device) return { saved: false, env: null };
    const orgId = ctx.device.organization_id;
    const cfg = getSettings(orgId);
    const photo = cfg.photo ? decodePhoto(evidence.photo) : null;
    let env = null;
    if (cfg.env && validSignature(evidence.env)) {
      const day = ctx.shiftDate || new Date().toISOString().slice(0, 10);
      env = evaluateEnv(ctx.device, evidence.env, day);
    }
    if (!photo && !env) return { saved: false, env: null };
    db.prepare(`INSERT INTO mark_photos (id, organization_id, device_id, employee_id, mark_id, offline_id, shift_date, mark_type, method, taken_at, mime, bytes, data, env_status, env_distance)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uid('mph'), orgId, ctx.device.id, ctx.employeeId || null, ctx.markId || null, ctx.offlineId || null, ctx.shiftDate || null,
        ctx.markType || null, ctx.method || null, ctx.takenAt || new Date().toISOString(),
        photo ? photo.mime : null, photo ? photo.buf.length : null, photo ? photo.buf : null,
        env ? env.status : null, env && env.distance != null ? env.distance : null);
    return { saved: !!photo, env };
  } catch (e) {
    console.error('[evidencia]', e.message);
    return { saved: false, env: null };
  }
}

// Borra las fotos con mas de 30 dias (la marcacion se conserva).
function purgeOldPhotos() {
  const r = db.prepare(`DELETE FROM mark_photos WHERE taken_at < ?`).run(new Date(Date.now() - PHOTO_DAYS * 86400000).toISOString());
  return r.changes;
}
const purgeTimer = setInterval(() => { try { purgeOldPhotos(); } catch (e) { console.error('[evidencia]', e.message); } }, 60 * 60 * 1000);
if (purgeTimer.unref) purgeTimer.unref();
setTimeout(() => { try { purgeOldPhotos(); } catch { /* nada */ } }, 30 * 1000).unref?.();

module.exports = { PHOTO_DAYS, getSettings, setSettings, saveEvidence, purgeOldPhotos, resetEnv, envStatusForDevice, envDistance, validSignature, ENV_ALERT };
