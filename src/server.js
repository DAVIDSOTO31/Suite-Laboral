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
const attendance = require('./routes/attendance.routes');
const notifications = require('./routes/notifications.routes');
const leave = require('./routes/leave.routes');
const discipline = require('./routes/discipline.routes');
const certificates = require('./routes/certificates.routes');
const live = require('./lib/live');
const presence = require('./lib/presence');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---------------------------------------------------------------------------
// Hashes de los <script> inline de /public, calculados AUTOMATICAMENTE al
// arrancar el servidor a partir de los archivos reales. Asi, cuando se
// modifica una pagina (por ejemplo app.html), su nuevo hash se incluye solo
// en la politica de seguridad y el navegador no bloquea el script.
// (El navegador normaliza los saltos de linea CRLF a LF antes de calcular el
// hash, por eso se hace lo mismo aqui.)
// ---------------------------------------------------------------------------
function computeInlineScriptHashes() {
  const hashes = new Set();
  let files = [];
  try { files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html')); } catch { return []; }
  const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const f of files) {
    let html;
    try { html = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8').replace(/\r\n?/g, '\n'); } catch { continue; }
    let m;
    while ((m = re.exec(html)) !== null) {
      const digest = require('node:crypto').createHash('sha256').update(m[1], 'utf8').digest('base64');
      hashes.add(`'sha256-${digest}'`);
    }
  }
  return [...hashes];
}
const AUTO_INLINE_SCRIPT_HASHES = computeInlineScriptHashes();
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
    // Actualizacion en vivo: si el cambio salio bien, se avisa a las demas
    // pestanas de la misma organizacion (solo el aviso, nunca los datos).
    try {
      if (user && user.organizationId && method !== 'GET' && res.statusCode < 400 && !res.skipLive) {
        const scopes = live.scopesForPath(routePath.replace(/:[a-zA-Z]+/g, 'x'));
        if (scopes) live.publish(user.organizationId, { scopes, by: user.email, userId: user.id, clientId: String(req.headers['x-client-id'] || '').slice(0, 64) || null, kind: routePath });
      }
    } catch (e) { console.error('[en vivo]', e.message); }
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
route('POST', '/api/superadmin/backup/verify', [requireSuperAdmin], (req, res) => superadmin.verifyBackupCopy(req, res));
route('GET', '/api/superadmin/presence', [requireSuperAdmin], (req, res) => superadmin.listPresence(req, res));
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
route('DELETE', '/api/superadmin/users/:id', [requireSuperAdmin], (req, res, params) => superadmin.deleteUser(req, res, params));
route('POST', '/api/superadmin/users/:id/reset-password', [requireSuperAdmin], (req, res, params) => superadmin.resetUserPassword(req, res, params));
route('GET', '/api/superadmin/roles', [requireSuperAdmin], (req, res, params, query) => superadmin.listRolesForOrg(req, res, query));
route('GET', '/api/superadmin/audit', [requireSuperAdmin], (req, res, params, query) => superadmin.listAuditLogs(req, res, query));

// ---- Organization-scoped endpoints ----
route('GET', '/api/org/data', [], (req, res, params, query) => org.getOrgData(req, res, query));
// Reemplaza TODOS los datos por un ejemplo: solo quien administra la configuracion.
route('PUT', '/api/org/settings', [requirePermission('settings.manage')], (req, res) => org.updateSettings(req, res));
// Ajustes manuales de la liquidacion: los ve quien ve nomina; solo el administrador los hace.
route('GET', '/api/payroll/adjustments', [requirePermission('reports.view')], (req, res, params, query) => org.listPayrollAdjustments(req, res, query));
route('PUT', '/api/payroll/adjustments', [requirePermission('employees.edit_payroll')], (req, res) => org.savePayrollAdjustment(req, res));
route('POST', '/api/payroll/adjustments/reset', [requirePermission('employees.edit_payroll')], (req, res) => org.resetPayrollAdjustments(req, res));
// Dia 0 de la organizacion y saldos iniciales de colaboradores (migraciones).
route('PUT', '/api/org/day-zero', [requirePermission('settings.manage')], (req, res) => org.setDayZero(req, res));
route('PUT', '/api/payroll/opening-balance', [requirePermission('employees.edit_payroll')], (req, res) => org.saveOpeningBalance(req, res));
route('POST', '/api/payroll/opening-balance/:employeeId/delete', [requirePermission('employees.edit_payroll')], (req, res, params) => org.deleteOpeningBalance(req, res, params));
// Cuadro de turnos: publicar, historial de cambios y patrones de rotacion.
route('POST', '/api/shifts/publish', [requirePermission('shifts.edit')], (req, res) => org.publishShifts(req, res));
route('GET', '/api/discipline', [requirePermission('employees.view')], (req, res, params, query) => discipline.listCases(req, res, query));
route('PUT', '/api/discipline/config', [requirePermission('employees.edit')], (req, res) => discipline.saveConfig(req, res));
route('GET', '/api/discipline/:id/draft', [requirePermission('employees.edit')], (req, res, params) => discipline.draftCase(req, res, params));
route('POST', '/api/discipline/:id/decide', [requirePermission('employees.edit')], (req, res, params) => discipline.decideCase(req, res, params));
route('POST', '/api/discipline/:id/link', [requirePermission('employees.edit')], (req, res, params) => discipline.createLink(req, res, params));
// Enlace publico del colaborador (sin sesion; protegido por el token del enlace).
route('GET', '/api/public/comunicacion/:token', [], (req, res, params) => discipline.publicView(req, res, params), { auth: false });
route('POST', '/api/public/comunicacion/:token/sign', [], (req, res, params) => discipline.publicSign(req, res, params), { auth: false });
route('GET', '/api/discipline/:id/signature', [requirePermission('employees.view')], (req, res, params) => discipline.caseSignature(req, res, params));
route('POST', '/api/public/comunicacion/:token/ack', [], (req, res, params) => discipline.publicAck(req, res, params), { auth: false });
// Certificados laborales: solo el Administrador (employees.edit_payroll).
route('GET', '/api/certificates', [requirePermission('employees.edit_payroll')], (req, res, params, query) => certificates.listCertificates(req, res, query));
route('PUT', '/api/certificates/config', [requirePermission('employees.edit_payroll')], (req, res) => certificates.saveCertificateConfig(req, res));
route('POST', '/api/certificates/draft', [requirePermission('employees.edit_payroll')], (req, res) => certificates.draftCertificate(req, res));
route('POST', '/api/certificates', [requirePermission('employees.edit_payroll')], (req, res) => certificates.createCertificate(req, res));
route('POST', '/api/certificates/:id/annul', [requirePermission('employees.edit_payroll')], (req, res, params) => certificates.annulCertificate(req, res, params));
route('POST', '/api/certificates/:id/link', [requirePermission('employees.edit_payroll')], (req, res, params) => certificates.certificateLink(req, res, params));
route('GET', '/api/public/certificado/verificar/:code', [], (req, res, params) => certificates.publicVerify(req, res, params), { auth: false });
route('GET', '/api/public/certificado/:token', [], (req, res, params) => certificates.publicCertificate(req, res, params), { auth: false });
route('GET', '/api/rest-days', [requirePermission('shifts.view')], (req, res, params, query) => leave.listRestDays(req, res, query));
route('GET', '/api/vacations', [requirePermission('shifts.view')], (req, res, params, query) => leave.listVacations(req, res, query));
route('POST', '/api/vacations/moves', [requirePermission('shifts.edit')], (req, res) => leave.addVacationMove(req, res));
route('POST', '/api/vacations/initial', [requirePermission('shifts.edit')], (req, res) => leave.saveVacationInitial(req, res));
route('POST', '/api/rest-days/moves', [requirePermission('shifts.edit')], (req, res) => leave.addRestDayMove(req, res));
route('GET', '/api/shifts/changes', [requirePermission('shifts.view')], (req, res, params, query) => org.listShiftChanges(req, res, query));
route('PUT', '/api/org/rotation-patterns', [requirePermission('shifts.edit')], (req, res) => org.replaceRotationPatterns(req, res));
// Cierres de periodo (recargos y horas extras por separado).
route('GET', '/api/payroll/closures', [requirePermission('reports.view')], (req, res, params, query) => org.listPayrollClosures(req, res, query));
route('POST', '/api/payroll/closures', [requirePermission('employees.edit_payroll')], (req, res) => org.createPayrollClosure(req, res));
route('POST', '/api/payroll/closures/:id/reopen', [requirePermission('employees.edit_payroll')], (req, res, params) => org.reopenPayrollClosure(req, res, params));
route('PUT', '/api/org/departments', [requirePermission('settings.manage')], (req, res) => org.replaceDepartments(req, res));
route('PUT', '/api/org/shift-presets', [requirePermission('shifts.edit')], (req, res) => org.replaceShiftPresets(req, res));
route('POST', '/api/org/sync', [(req, res, user) => user.isSuperAdmin || user.permissions.has('shifts.edit') || user.permissions.has('employees.edit') ? true : (sendJson(res, 403, { error: 'No tienes permiso para guardar cambios.' }), false)], (req, res) => org.syncEmployeesAndShifts(req, res));
// Retiro de colaboradores (en vez de borrarlos): se conserva su historial.
route('POST', '/api/employees/:id/retire', [requirePermission('employees.delete')], (req, res, params) => org.retireEmployee(req, res, params));
route('POST', '/api/employees/:id/reactivate', [requirePermission('employees.delete')], (req, res, params) => org.reactivateEmployee(req, res, params));
route('POST', '/api/employees/:id/delete-permanent', [requirePermission('employees.delete')], (req, res, params) => org.deleteEmployeePermanent(req, res, params));
route('GET', '/api/employees/:id/has-history', [requirePermission('employees.delete')], (req, res, params, query) => org.employeeHistoryCheck(req, res, params, query));
// Ventana de turnos: turnos anteriores bajo demanda; depuración automática.
route('GET', '/api/org/shifts', [], (req, res, params, query) => org.getShiftsRange(req, res, query));
route('GET', '/api/org/shift-locks', [], (req, res, params, query) => org.getShiftLocks(req, res, query));
route('PUT', '/api/org/data-retention', [requirePermission('settings.manage')], (req, res) => org.saveDataRetention(req, res));
route('GET', '/api/org/users', [requirePermission('users.view')], (req, res) => org.listOrgUsers(req, res));
route('POST', '/api/org/users', [requirePermission('users.create')], (req, res) => org.createOrgUser(req, res));
route('PUT', '/api/org/users/:id', [requirePermission('users.edit')], (req, res, params) => org.updateOrgUser(req, res, params));
route('POST', '/api/org/users/:id/toggle-status', [requirePermission('users.delete')], (req, res, params) => org.toggleOrgUserStatus(req, res, params));
route('POST', '/api/org/users/:id/reset-password', [requirePermission('users.reset_password')], (req, res, params) => org.resetOrgUserPassword(req, res, params));
route('GET', '/api/org/audit', [requirePermission('audit.view')], (req, res, params, query) => org.listOrgAudit(req, res, query));

// ---- Modulo de Asistencia (marcaciones, historial, alertas) ----
route('GET', '/api/attendance/employees-today', [requirePermission('attendance.view')], (req, res, params, query) => attendance.listEmployeesToday(req, res, query));
route('POST', '/api/attendance/mark', [requirePermission('attendance.mark')], (req, res) => attendance.registerMark(req, res));
route('GET', '/api/attendance/history', [requirePermission('attendance.view')], (req, res, params, query) => attendance.listHistory(req, res, query));
// Correccion de marcaciones de dias pasados: solo quien puede marcar manualmente (Administrador).
route('POST', '/api/attendance/corrections', [requirePermission('attendance.mark')], (req, res) => attendance.registerCorrection(req, res));
route('POST', '/api/attendance/half-day', [requirePermission('attendance.mark')], (req, res) => attendance.decideHalfDay(req, res));
route('GET', '/api/attendance/day-marks', [requirePermission('attendance.mark')], (req, res, params, query) => attendance.listDayMarks(req, res, query));
route('POST', '/api/attendance/marks/:id/void', [requirePermission('attendance.mark')], (req, res, params) => attendance.voidMark(req, res, params));
route('GET', '/api/attendance/corrections', [requirePermission('attendance.view')], (req, res, params, query) => attendance.listCorrections(req, res, query));
// "Mis marcaciones": cada usuario ve solo las de su propia ficha de colaborador.
route('GET', '/api/attendance/my-history', [requirePermission('self.view')], (req, res, params, query) => attendance.listMyHistory(req, res, query));
route('GET', '/api/attendance/alerts', [requirePermission('attendance.view_alerts')], (req, res, params, query) => attendance.listAlerts(req, res, query));
route('GET', '/api/attendance/evidence', [requirePermission('attendance.view')], (req, res, params, query) => attendance.listMarkEvidence(req, res, query));
route('GET', '/api/attendance/evidence/:id/photo', [requirePermission('attendance.view')], (req, res, params) => attendance.getMarkEvidencePhoto(req, res, params));
route('POST', '/api/attendance/evidence/:id/env-ok', [requirePermission('attendance.view_alerts')], (req, res, params) => attendance.confirmEvidenceEnvOk(req, res, params));
route('GET', '/api/attendance/evidence-settings', [requirePermission('attendance.view')], (req, res, params, query) => attendance.getEvidenceSettings(req, res, query));
route('PUT', '/api/attendance/evidence-settings', [requirePermission('settings.manage')], (req, res) => attendance.saveEvidenceSettings(req, res));
route('POST', '/api/attendance/devices/:id/env-reset', [requirePermission('attendance.manage_devices')], (req, res, params) => attendance.resetDeviceEnv(req, res, params));
// Tablero "Hoy" y gestion de novedades (justificar / injustificar con nota y soporte).
route('GET', '/api/attendance/today', [requirePermission('attendance.view')], (req, res, params, query) => attendance.todayBoard(req, res, query));
route('GET', '/api/attendance/novedades', [requirePermission('attendance.view_alerts')], (req, res, params, query) => attendance.novedadesSummary(req, res, query));
route('POST', '/api/attendance/alerts/:id/manage', [requirePermission('attendance.view_alerts')], (req, res, params) => attendance.manageAlert(req, res, params));
route('GET', '/api/attendance/alerts/:id/attachment', [requirePermission('attendance.view_alerts')], (req, res, params) => attendance.getAlertAttachment(req, res, params));
// Indicadores de asistencia (gerencia) y resumen diario por correo.
// Centro de notificaciones (campana) y avisos al celular: Administrador y Supervisor.
route('GET', '/api/notifications', [requirePermission('attendance.view_alerts')], (req, res) => notifications.listNotifications(req, res));
route('POST', '/api/notifications/seen', [requirePermission('attendance.view_alerts')], (req, res) => notifications.markSeen(req, res));
route('GET', '/api/push/key', [requirePermission('attendance.view_alerts')], (req, res) => notifications.publicKey(req, res));
route('POST', '/api/push/subscribe', [requirePermission('attendance.view_alerts')], (req, res) => notifications.subscribe(req, res));
route('POST', '/api/push/unsubscribe', [requirePermission('attendance.view_alerts')], (req, res) => notifications.unsubscribe(req, res));
route('POST', '/api/push/test', [requirePermission('attendance.view_alerts')], (req, res) => notifications.sendTest(req, res));
route('GET', '/api/attendance/indicators', [requirePermission('attendance.view_alerts')], (req, res, params, query) => attendance.indicators(req, res, query));
route('GET', '/api/attendance/indicator-goals', [requirePermission('attendance.view')], (req, res, params, query) => attendance.getIndicatorGoalsRoute(req, res, query));
route('PUT', '/api/attendance/indicator-goals', [requirePermission('settings.manage')], (req, res) => attendance.saveIndicatorGoals(req, res));
route('GET', '/api/attendance/digest-settings', [requirePermission('settings.manage')], (req, res, params, query) => attendance.getDigestSettingsRoute(req, res, query));
route('PUT', '/api/attendance/digest-settings', [requirePermission('settings.manage')], (req, res) => attendance.saveDigestSettings(req, res));
route('POST', '/api/attendance/digest-test', [requirePermission('settings.manage')], (req, res) => attendance.sendDigestTest(req, res));
route('GET', '/api/attendance/payroll-summary', [requirePermission('attendance.view')], (req, res, params, query) => attendance.listPayrollAttendance(req, res, query));
route('GET', '/api/attendance/face-profiles', [requirePermission('attendance.manage_biometrics')], (req, res, params, query) => attendance.listFaceProfiles(req, res, query));
route('POST', '/api/attendance/face-profiles', [requirePermission('attendance.manage_biometrics')], (req, res) => attendance.enrollFaceProfile(req, res));
route('POST', '/api/attendance/face-profiles/:id/deactivate', [requirePermission('attendance.manage_biometrics')], (req, res, params) => attendance.deactivateFaceProfile(req, res, params));
route('POST', '/api/attendance/mark-by-face', [requirePermission('attendance.mark')], (req, res) => attendance.registerMarkByFace(req, res));

// ---- Dispositivos de marcacion (administracion, requiere sesion) ----
route('GET', '/api/attendance/devices', [requirePermission('attendance.manage_devices')], (req, res, params, query) => attendance.listDevices(req, res, query));
route('POST', '/api/attendance/devices', [requirePermission('attendance.manage_devices')], (req, res) => attendance.createDevice(req, res));
route('POST', '/api/attendance/devices/:id/rotate', [requirePermission('attendance.manage_devices')], (req, res, params) => attendance.rotateDeviceToken(req, res, params));
route('POST', '/api/attendance/devices/:id/deactivate', [requirePermission('attendance.manage_devices')], (req, res, params) => attendance.deactivateDevice(req, res, params));
route('DELETE', '/api/attendance/devices/:id', [requirePermission('attendance.manage_devices')], (req, res, params) => attendance.deleteDevice(req, res, params));
route('GET', '/api/attendance/devices/:id/employees', [requirePermission('attendance.manage_devices')], (req, res, params, query) => attendance.getDeviceAssignments(req, res, params, query));
route('POST', '/api/attendance/devices/:id/employees', [requirePermission('attendance.manage_devices')], (req, res, params) => attendance.setDeviceAssignments(req, res, params));
// Salud de los dispositivos: historial de eventos y avisos por correo.
route('GET', '/api/attendance/devices/:id/events', [requirePermission('attendance.manage_devices')], (req, res, params, query) => attendance.listDeviceEvents(req, res, params, query));
route('GET', '/api/attendance/device-alert-settings', [requirePermission('attendance.manage_devices')], (req, res, params, query) => attendance.getDeviceAlertSettingsRoute(req, res, query));
route('PUT', '/api/attendance/device-alert-settings', [requirePermission('attendance.manage_devices')], (req, res) => attendance.saveDeviceAlertSettings(req, res));
// Marcaciones guardadas sin conexion que necesitan revision del administrador.
route('GET', '/api/attendance/offline-marks', [requirePermission('attendance.manage_devices')], (req, res, params, query) => attendance.listOfflineMarks(req, res, query));
route('POST', '/api/attendance/offline-marks/:id/apply', [requirePermission('attendance.mark')], (req, res, params) => attendance.applyOfflineMark(req, res, params));
route('POST', '/api/attendance/offline-marks/:id/discard', [requirePermission('attendance.mark')], (req, res, params) => attendance.discardOfflineMark(req, res, params));

// ---- Kiosco de marcacion: SIN sesion de usuario, autenticado por el token
// propio del dispositivo (header X-Device-Token). Ver attendance.routes.js. ----
route('GET', '/api/kiosk/employees-today', [], (req, res) => attendance.kioskEmployeesToday(req, res), { auth: false });
route('POST', '/api/kiosk/mark', [], (req, res) => attendance.kioskMark(req, res), { auth: false });
route('POST', '/api/kiosk/mark-by-face', [], (req, res) => attendance.kioskMarkByFace(req, res), { auth: false });
route('POST', '/api/kiosk/heartbeat', [], (req, res) => attendance.kioskHeartbeat(req, res), { auth: false });
route('POST', '/api/kiosk/sync', [], (req, res) => attendance.kioskSync(req, res), { auth: false });
route('GET', '/api/kiosk/live', [], (req, res) => attendance.kioskLiveVersion(req, res), { auth: false });
route('GET', '/api/kiosk/offline-cache', [], (req, res) => attendance.kioskOfflineCache(req, res), { auth: false });

// ---- Actualizacion en vivo (Server-Sent Events) para la suite ----
route('GET', '/api/org/live', [], (req, res) => {
  const user = req.user;
  if (!user.organizationId) return sendJson(res, 400, { error: 'Solo para cuentas de organizacion.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  const off = live.subscribe(user.organizationId, res, { userId: user.id, clientId: String(req.headers['x-client-id'] || '') });
  req.on('close', () => { off(); presence.touchNow(user.id); });
});

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
    "'sha256-+8oC1r72WbiPtRyv4AZuPBJf05noo7E6XX2RGuYlE0s='", // app.html
    "'sha256-jFjh+xQlYnmCK2nC+EGGlYAG7HTCMMRZDPZjFZz8MwE='", // kiosk.html
    "'sha256-SkZ8MDP1PB+wba8BkIrLszFlOTQ9YEjBIPu4TsJPKTo='", // superadmin.html
    "'sha256-acq3Igc1f3abTnmdP0vrk+f21ykK7GXxlTu0HAeDxD8='", // accept-invite.html
    "'sha256-p7WRDAOI/vt0mUjmPWtSZe+ugsLNJkiYzKuVx61YsjA='", // forgot-password.html
    "'sha256-mZ3lS9DOiVRo7hkAzBXkRD0YGddIYpBoAsC0YnepqJQ='", // reset-password.html
  ].concat(AUTO_INLINE_SCRIPT_HASHES.map(h => h)).filter((h, i, all) => all.indexOf(h) === i).join(' ');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data:; " +
    // frame-src blob:: el visor de PDF dentro de la suite (llamados firmados)
    // muestra el PDF que el mismo navegador acaba de armar, sin descargarlo.
    "frame-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    `script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net ${INLINE_SCRIPT_HASHES}; ` +
    // connect-src: el modulo de Asistencia carga los "pesos" del modelo de
    // reconocimiento facial (face-api.js) desde el mismo CDN del script.
    // Esto NO envia fotos de los empleados a ningun lado -- solo descarga
    // el modelo de IA una vez (se queda en cache del navegador).
    // cdn.tailwindcss.com y cdnjs.cloudflare.com: el Kiosco RR.HH (app instalable)
    // guarda esas librerias en el equipo para poder abrir sin internet.
    "connect-src 'self' https://cdn.jsdelivr.net https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; " +
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
    // Librerias de /vendor: el nombre lleva la version, asi que el navegador
    // puede guardarlas un año (si cambian, cambia el nombre del archivo).
    if (filePath.startsWith('/vendor/')) return sendFile(res, fullPath, { 'Cache-Control': 'public, max-age=31536000, immutable' });
    return sendFile(res, fullPath);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(env.PORT, () => {
  console.log(`\nRR.HH PYMES multi-tenant escuchando en http://localhost:${env.PORT}`);
  console.log(`Abre http://localhost:${env.PORT} en tu navegador.\n`);
});
