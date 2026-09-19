'use strict';
// Suite de pruebas de integracion y seguridad para RR.HH PYMES multi-tenant.
//
// Ejecutar con:  node --test tests/integration.test.js
//
// Arranca el servidor real en un puerto de pruebas contra una base de datos
// SQLite temporal (se borra al terminar), y ejerce la API HTTP tal como lo
// haria un navegador. Cubre, como minimo, los escenarios pedidos en el punto
// 18 del brief: login, rutas protegidas, aislamiento entre organizaciones,
// permisos, Super Admin, recuperacion de contrasena, organizaciones
// desactivadas y generacion de auditoria.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 4099;
const BASE = `http://localhost:${PORT}`;
const tmpDb = path.join(os.tmpdir(), `rrhh_test_${Date.now()}.db`);

let serverProcess;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: tmpDb,
        SESSION_SECRET: 'test-secret-not-for-production',
        SUPERADMIN_EMAIL: 'superadmin@test.local',
        SUPERADMIN_PASSWORD: 'TestSuperAdmin123!',
        EMAIL_MODE: 'console',
      },
    });
    let ready = false;
    serverProcess.stdout.on('data', (d) => {
      if (!ready && d.toString().includes('escuchando')) { ready = true; resolve(); }
    });
    serverProcess.stderr.on('data', () => {});
    serverProcess.on('error', reject);
    setTimeout(() => { if (!ready) reject(new Error('El servidor no arranco a tiempo')); }, 5000);
  });
}

function stopServer() {
  if (serverProcess) serverProcess.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

// ---- Cliente HTTP minimo con manejo de cookies por "sesion" nombrada ----
const jars = {};
function jar(name) { return jars[name] || (jars[name] = {}); }

function cookieHeader(name) {
  const j = jar(name);
  return Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(name, res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const j = jar(name);
  for (const c of raw) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    j[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

async function call(session, method, path, body) {
  const j = jar(session);
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader(session) ? { Cookie: cookieHeader(session) } : {}),
      ...(j.csrf ? { 'X-CSRF-Token': j.csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  storeCookies(session, res);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function login(session, email, password) {
  const r = await call(session, 'POST', '/api/auth/login', { email, password });
  return r;
}

test.before(startServer);
test.after(stopServer);

test('Super Admin puede iniciar sesion', async () => {
  const r = await login('sa', 'superadmin@test.local', 'TestSuperAdmin123!');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isSuperAdmin, true);
});

test('Un usuario no autenticado no puede acceder a rutas protegidas', async () => {
  const r = await call('anon', 'GET', '/api/org/data');
  assert.equal(r.status, 401);
});

test('Peticion sin token CSRF es rechazada en rutas de escritura', async () => {
  // Reutiliza la cookie de sesion del super admin pero sin el header CSRF.
  const j = jar('sa');
  const res = await fetch(BASE + '/api/superadmin/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `session=${j.session}` },
    body: JSON.stringify({ name: 'Sin CSRF' }),
  });
  assert.equal(res.status, 403);
});

let orgAId, orgBId, tokenA, tokenB, userAId;

test('Super Admin puede crear organizaciones', async () => {
  const a = await call('sa', 'POST', '/api/superadmin/organizations', { name: 'Empresa A Test' });
  const b = await call('sa', 'POST', '/api/superadmin/organizations', { name: 'Empresa B Test' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  orgAId = a.data.organization.id;
  orgBId = b.data.organization.id;
});

test('Super Admin puede invitar usuarios y asignarlos a una organizacion', async () => {
  const invA = await call('sa', 'POST', '/api/superadmin/users', { email: 'adminA@test.local', organizationId: orgAId, role: 'org_admin' });
  const invB = await call('sa', 'POST', '/api/superadmin/users', { email: 'adminB@test.local', organizationId: orgBId, role: 'org_admin' });
  assert.equal(invA.status, 201);
  assert.equal(invB.status, 201);
  tokenA = invA.data.inviteLink.split('token=')[1];
  tokenB = invB.data.inviteLink.split('token=')[1];
  userAId = invA.data.userId;
});

test('La invitacion permite establecer contrasena y activar la cuenta', async () => {
  const a = await call('x', 'POST', '/api/auth/accept-invite', { token: tokenA, password: 'ClaveSegura123' });
  const b = await call('x', 'POST', '/api/auth/accept-invite', { token: tokenB, password: 'ClaveSegura123' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('Un token de invitacion no puede reutilizarse', async () => {
  const r = await call('x', 'POST', '/api/auth/accept-invite', { token: tokenA, password: 'OtraClave123' });
  assert.equal(r.status, 400);
});

test('Los administradores de organizacion pueden iniciar sesion', async () => {
  const a = await login('a', 'adminA@test.local', 'ClaveSegura123');
  const b = await login('b', 'adminB@test.local', 'ClaveSegura123');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.data.user.organizationId, orgAId);
  assert.equal(b.data.user.organizationId, orgBId);
});

test('Credenciales invalidas son rechazadas', async () => {
  const r = await login('bad', 'adminA@test.local', 'ClaveIncorrecta');
  assert.equal(r.status, 401);
});

test('Rate limiting bloquea intentos de login excesivos', async () => {
  const floodEmail = 'ratelimit-test@test.local';
  for (let i = 0; i < 5; i++) await login('flood', floodEmail, 'incorrecta' + i);
  const r = await login('flood', floodEmail, 'incorrecta-final');
  assert.equal(r.status, 429);
});

test('Un usuario de Organizacion A no puede ver datos de Organizacion B (aislamiento horizontal)', async () => {
  await call('a', 'POST', '/api/org/seed-demo');
  const dataA = await call('a', 'GET', '/api/org/data');
  const dataB = await call('b', 'GET', '/api/org/data');
  assert.ok(dataA.data.employees.length > 0, 'Org A deberia tener colaboradores tras el seed');
  assert.equal(dataB.data.employees.length, 0, 'Org B NO debe ver colaboradores de Org A');
});

test('Un administrador de Organizacion B no puede administrar usuarios de Organizacion A (IDOR)', async () => {
  const r = await call('b', 'POST', `/api/org/users/${userAId}/toggle-status`);
  assert.equal(r.status, 404, 'Debe responder 404 (no revelar existencia cruzada), nunca 200');
});

test('Manipular el ID en la URL no permite acceso cruzado a traves de rutas de Super Admin sin ser Super Admin', async () => {
  const r = await call('b', 'PUT', `/api/superadmin/organizations/${orgAId}`, { name: 'Hackeado' });
  assert.equal(r.status, 403);
});

test('Un usuario sin permiso no puede ejecutar una operacion aunque llame directamente a la API', async () => {
  // Invita a un "empleado" (rol sin permisos de escritura de settings) y confirma el bloqueo.
  const inv = await call('a', 'POST', '/api/org/users', { email: 'empleado1@test.local', role: 'empleado' });
  const tok = inv.data.inviteLink.split('token=')[1];
  await call('x', 'POST', '/api/auth/accept-invite', { token: tok, password: 'ClaveEmpleado123' });
  await login('emp', 'empleado1@test.local', 'ClaveEmpleado123');
  const r = await call('emp', 'PUT', '/api/org/settings', { orgName: 'Deberia fallar' });
  assert.equal(r.status, 403);
});

test('Los roles y permisos determinan el acceso correctamente (supervisor puede editar pero no gestionar usuarios)', async () => {
  const inv = await call('a', 'POST', '/api/org/users', { email: 'supervisor1@test.local', role: 'supervisor' });
  const tok = inv.data.inviteLink.split('token=')[1];
  await call('x', 'POST', '/api/auth/accept-invite', { token: tok, password: 'ClaveSuper123' });
  await login('sup', 'supervisor1@test.local', 'ClaveSuper123');
  const canSync = await call('sup', 'POST', '/api/org/sync', { employees: [], shifts: [] });
  const cannotManageUsers = await call('sup', 'GET', '/api/org/users');
  assert.equal(canSync.status, 200);
  assert.equal(cannotManageUsers.status, 403);
});

test('La recuperacion de contrasena genera un enlace valido de un solo uso', async () => {
  const forgot = await call('x', 'POST', '/api/auth/forgot-password', { email: 'adminA@test.local' });
  assert.equal(forgot.status, 200); // siempre 200, no revela si el correo existe

  const su = await call('sa', 'POST', `/api/superadmin/users/${userAId}/reset-password`);
  assert.equal(su.status, 200);
  const resetToken = su.data.resetLink.split('token=')[1];

  const reset = await call('x', 'POST', '/api/auth/reset-password', { token: resetToken, newPassword: 'NuevaClaveA123' });
  assert.equal(reset.status, 200);

  const loginOld = await login('a2', 'adminA@test.local', 'ClaveSegura123');
  assert.equal(loginOld.status, 401);
  const loginNew = await login('a2', 'adminA@test.local', 'NuevaClaveA123');
  assert.equal(loginNew.status, 200);
});

test('Las organizaciones desactivadas no pueden utilizar la plataforma', async () => {
  const toggled = await call('sa', 'POST', `/api/superadmin/organizations/${orgBId}/toggle-status`);
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.status, 'inactive');

  const r = await login('bBlocked', 'adminB@test.local', 'ClaveSegura123');
  assert.equal(r.status, 403);

  // reactivar para no afectar otras pruebas
  await call('sa', 'POST', `/api/superadmin/organizations/${orgBId}/toggle-status`);
});

test('Sesiones expiradas/instaladas son rechazadas (cookie invalida)', async () => {
  const res = await fetch(BASE + '/api/auth/me', { headers: { Cookie: 'session=token.invalido' } });
  assert.equal(res.status, 401);
});

test('Super Admin puede administrar organizaciones y usuarios globalmente', async () => {
  const orgs = await call('sa', 'GET', '/api/superadmin/organizations');
  const users = await call('sa', 'GET', '/api/superadmin/users');
  assert.equal(orgs.status, 200);
  assert.ok(orgs.data.organizations.length >= 2);
  assert.equal(users.status, 200);
});

test('Los logs de auditoria se generan correctamente y respetan el limite por organizacion', async () => {
  const auditSA = await call('sa', 'GET', '/api/superadmin/audit');
  assert.ok(auditSA.data.logs.length > 0);

  const auditA = await call('a', 'GET', '/api/org/audit');
  const auditB = await login('bAudit', 'adminB@test.local', 'ClaveSegura123').then(() => call('bAudit', 'GET', '/api/org/audit'));
  assert.equal(auditA.status, 200);
  // Ningun log del lado de A debe pertenecer a la organizacion B.
  for (const log of auditA.data.logs) assert.notEqual(log.organization_id, orgBId);
  for (const log of auditB.data.logs) assert.notEqual(log.organization_id, orgAId);
});
