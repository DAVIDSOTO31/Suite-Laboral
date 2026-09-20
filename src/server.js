'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const url = require('node:url');
const env = require('./lib/env');
require('./db'); // initializes schema + bootstraps super admin on first run
const { sendJson, sendFile, getClientIp, Router } = require('./lib/http');
const { requireAuth, requireCsrf, requirePermission, requireSuperAdmin, loadUserFromRequest } = require('./middleware/auth');

const authRoutes = require('./routes/auth.routes');
const superadmin = require('./routes/superadmin.routes');
const org = require('./routes/org.routes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const router = new Router();

// ---------------------------------------------------------------------------
// Route registration helper. `guards` is an array of (req,res,user) => boolean
// run in order after authentication; the request is rejected as soon as one
// returns false (that guard already sent the response).
// ---------------------------------------------------------------------------
function route(method, routePath, guards, handler, { auth = true } = {}) {
  router.add(method, routePath, async (req, res, params, query) => {
    let user = null;
    if (auth) {
      user = requireAuth(req, res);
      if (!user) return;
      if (!requireCsrf(req, res, user)) return;
      for (const guard of guards || []) {
        if (!guard(req, res, user)) return;
      }
      req.user = user;
    }
    try {
      await handler(req, res, params, query);
    } catch (e) {
      console.error('Handler error:', e);
      sendJson(res, 500, { error: 'Error interno del servidor.' });
    }
  });
}

// ---- Public auth endpoints (no session required yet) ----
router.post('/api/auth/login', (req, res) => authRoutes.login(req, res));
router.post('/api/auth/logout', (req, res) => authRoutes.logout(req, res));
router.get('/api/auth/me', (req, res) => authRoutes.me(req, res));
router.post('/api/auth/forgot-password', (req, res) => authRoutes.forgotPassword(req, res));
router.post('/api/auth/reset-password', (req, res) => authRoutes.resetPassword(req, res));
router.post('/api/auth/accept-invite', (req, res) => authRoutes.acceptInvite(req, res));

// ---- Super Admin endpoints ----
route('GET', '/api/superadmin/dashboard', [requireSuperAdmin], (req, res) => superadmin.dashboard(req, res));
route('GET', '/api/superadmin/organizations', [requireSuperAdmin], (req, res, params, query) => superadmin.listOrganizations(req, res, query));
route('POST', '/api/superadmin/organizations', [requireSuperAdmin], (req, res) => superadmin.createOrganization(req, res));
route('GET', '/api/superadmin/organizations/:id', [requireSuperAdmin], (req, res, params) => superadmin.getOrganizationDetail(req, res, params));
route('PUT', '/api/superadmin/organizations/:id', [requireSuperAdmin], (req, res, params) => superadmin.updateOrganization(req, res, params));
route('POST', '/api/superadmin/organizations/:id/toggle-status', [requireSuperAdmin], (req, res, params) => superadmin.toggleOrganizationStatus(req, res, params));
route('DELETE', '/api/superadmin/organizations/:id', [requireSuperAdmin], (req, res, params) => superadmin.deleteOrganization(req, res, params));
route('GET', '/api/superadmin/users', [requireSuperAdmin], (req, res, params, query) => superadmin.listUsers(req, res, query));
route('POST', '/api/superadmin/users', [requireSuperAdmin], (req, res) => superadmin.createUser(req, res));
route('PUT', '/api/superadmin/users/:id', [requireSuperAdmin], (req, res, params) => superadmin.updateUser(req, res, params));
route('POST', '/api/superadmin/users/:id/toggle-status', [requireSuperAdmin], (req, res, params) => superadmin.toggleUserStatus(req, res, params));
route('POST', '/api/superadmin/users/:id/reset-password', [requireSuperAdmin], (req, res, params) => superadmin.resetUserPassword(req, res, params));
route('GET', '/api/superadmin/roles', [requireSuperAdmin], (req, res, params, query) => superadmin.listRolesForOrg(req, res, query));
route('GET', '/api/superadmin/audit', [requireSuperAdmin], (req, res, params, query) => superadmin.listAuditLogs(req, res, query));

// ---- Organization-scoped endpoints ----
route('GET', '/api/org/data', [], (req, res, params, query) => org.getOrgData(req, res, query));
route('POST', '/api/org/seed-demo', [requirePermission('employees.create')], (req, res, params, query) => org.seedDemo(req, res, query));
route('PUT', '/api/org/settings', [requirePermission('settings.manage')], (req, res) => org.updateSettings(req, res));
route('PUT', '/api/org/departments', [requirePermission('settings.manage')], (req, res) => org.replaceDepartments(req, res));
route('PUT', '/api/org/shift-presets', [requirePermission('shifts.edit')], (req, res) => org.replaceShiftPresets(req, res));
route('POST', '/api/org/sync', [(req, res, user) => user.isSuperAdmin || user.permissions.has('shifts.edit') || user.permissions.has('employees.edit') ? true : (sendJson(res, 403, { error: 'No tienes permiso para guardar cambios.' }), false)], (req, res) => org.syncEmployeesAndShifts(req, res));
route('GET', '/api/org/users', [requirePermission('users.view')], (req, res) => org.listOrgUsers(req, res));
route('POST', '/api/org/users', [requirePermission('users.create')], (req, res) => org.createOrgUser(req, res));
route('PUT', '/api/org/users/:id', [requirePermission('users.edit')], (req, res, params) => org.updateOrgUser(req, res, params));
route('POST', '/api/org/users/:id/toggle-status', [requirePermission('users.delete')], (req, res, params) => org.toggleOrgUserStatus(req, res, params));
route('POST', '/api/org/users/:id/reset-password', [requirePermission('users.reset_password')], (req, res, params) => org.resetOrgUserPassword(req, res, params));
route('GET', '/api/org/audit', [requirePermission('audit.view')], (req, res) => org.listOrgAudit(req, res));

// ---------------------------------------------------------------------------
// HTTP server: security headers, CORS, static files, API dispatch
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // script-src: 'self' + CDNs para los <script src="..."> externos (Tailwind, Chart.js),
  // mas un hash SHA-256 por cada bloque <script>...</script> inline que traen las paginas
  // de /public (login, app, superadmin, index, accept-invite, forgot/reset-password).
  // Si se edita el contenido de alguno de esos bloques <script>, su hash cambia y hay que
  // recalcularlo (ver README) o el navegador volvera a bloquearlo.
  const INLINE_SCRIPT_HASHES = [
    "'sha256-VHT9CPskO5vtuB4/dvdS04Q+SweVGZPL/1qWK+IKjFI='", // index.html
    "'sha256-dum9fwlx0dkN5ryTuRUUwv195GfaGUq71kgIuRd86vs='", // login.html
    "'sha256-Mw75BhCr8p7KOHnUhedU/phgSplvZ2WhY9Oiy0vo2jA='", // app.html
    "'sha256-Vg0lkpEUaRwl1e4TJtu3+bHOQPCIrP4qkdoMWzoPCJU='", // superadmin.html
    "'sha256-acq3Igc1f3abTnmdP0vrk+f21ykK7GXxlTu0HAeDxD8='", // accept-invite.html
    "'sha256-p7WRDAOI/vt0mUjmPWtSZe+ugsLNJkiYzKuVx61YsjA='", // forgot-password.html
    "'sha256-mZ3lS9DOiVRo7hkAzBXkRD0YGddIYpBoAsC0YnepqJQ='", // reset-password.html
  ].join(' ');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    `script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net ${INLINE_SCRIPT_HASHES}; ` +
    // app.html y superadmin.html usan onclick="..."/onchange="..." en vez de addEventListener.
    // 'unsafe-inline' aqui solo afecta a esos atributos de evento (no a los <script> del bloque
    // anterior, que ya quedan protegidos por los hashes de arriba).
    "script-src-attr 'unsafe-inline';");

  if (env.ALLOWED_ORIGIN && req.headers.origin === env.ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname.startsWith('/api/')) {
    const match = router.match(req.method, pathname);
    if (!match) return sendJson(res, 404, { error: 'Ruta no encontrada.' });
    try {
      await match.handler(req, res, match.params, parsed.query);
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: 'Error interno del servidor.' });
    }
    return;
  }

  // Static file serving for the frontend.
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) { res.writeHead(400); return res.end('Bad request'); }
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    return sendFile(res, fullPath);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(env.PORT, () => {
  console.log(`\nRR.HH PYMES multi-tenant escuchando en http://localhost:${env.PORT}`);
  console.log(`Abre http://localhost:${env.PORT} en tu navegador.\n`);
});
