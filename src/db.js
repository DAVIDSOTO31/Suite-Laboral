'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const env = require('./lib/env');
const { hashPassword } = require('./lib/crypto');

const dbPath = path.join(__dirname, '..', env.DB_PATH.replace(/^\.\//, ''));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// SCHEMA (idempotent: CREATE TABLE IF NOT EXISTS -> safe to re-run / migrate)
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, name)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NULL,
  is_super_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','invited','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bridge table: supports a user eventually belonging to more than one organization,
-- even though today the product only assigns a single organization per user (org_id on users).
CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  organization_id TEXT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_by TEXT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NULL,
  user_id TEXT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NULL,
  resource_id TEXT NULL,
  metadata_json TEXT NULL,
  ip TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Dominio de la aplicacion original (RR.HH PYMES), ahora con organization_id ----
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'fa-briefcase',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shift_presets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT,
  department_id TEXT,
  salary REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  org_name TEXT NOT NULL DEFAULT 'Empresa Demo',
  logo_base64 TEXT,
  minimum_wage REAL NOT NULL DEFAULT 1750905,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_employees_org ON employees(organization_id);
CREATE INDEX IF NOT EXISTS idx_shifts_org ON shifts(organization_id);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id);
`);

// ---------------------------------------------------------------------------
// MIGRATION: datos de contacto de la organizacion (nit, telefono, correo)
// ---------------------------------------------------------------------------
const orgColumns = db.prepare("PRAGMA table_info(organizations)").all().map(c => c.name);
if (!orgColumns.includes('nit')) db.exec('ALTER TABLE organizations ADD COLUMN nit TEXT');
if (!orgColumns.includes('phone')) db.exec('ALTER TABLE organizations ADD COLUMN phone TEXT');
if (!orgColumns.includes('contact_email')) db.exec('ALTER TABLE organizations ADD COLUMN contact_email TEXT');

// ---------------------------------------------------------------------------
// MODULO DE ASISTENCIA (marcaciones + alertas + estado diario) — NUEVO Y
// AISLADO: no toca ninguna tabla existente, solo agrega 3 tablas propias.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS attendance_marks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_date TEXT NOT NULL,
  mark_type TEXT NOT NULL,
  scheduled_time TEXT,
  actual_at TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'manual',
  marked_by_user_id TEXT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance_alerts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_date TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  scheduled_time TEXT,
  actual_time TEXT,
  diff_minutes INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance_devices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NULL REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attendance_devices_org ON attendance_devices(organization_id);

-- Que colaboradores puede reconocer/aceptar cada dispositivo (ej. solo los
-- de Bodega en el totem de Bodega). Si un empleado no esta aqui para un
-- dispositivo, ese dispositivo simplemente no lo reconoce, aunque su rostro
-- ya este registrado en la organizacion.
CREATE TABLE IF NOT EXISTS attendance_device_employees (
  device_id TEXT NOT NULL REFERENCES attendance_devices(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_device_employees_employee ON attendance_device_employees(employee_id);

CREATE TABLE IF NOT EXISTS employee_face_profiles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  descriptor_json TEXT NOT NULL,
  enrolled_by_user_id TEXT NULL REFERENCES users(id),
  consent_given INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT NULL,
  consent_text TEXT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_face_profiles_org ON employee_face_profiles(organization_id, active);

CREATE TABLE IF NOT EXISTS attendance_days (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente_entrada',
  scheduled_entrada TEXT, scheduled_inicio_almuerzo TEXT, scheduled_fin_almuerzo TEXT, scheduled_salida TEXT,
  entrada_real TEXT, inicio_almuerzo_real TEXT, fin_almuerzo_real TEXT, salida_real TEXT,
  retraso_min INTEGER NOT NULL DEFAULT 0,
  exceso_almuerzo_min INTEGER NOT NULL DEFAULT 0,
  salida_anticipada_min INTEGER NOT NULL DEFAULT 0,
  hod_min INTEGER NOT NULL DEFAULT 0,
  hon_min INTEGER NOT NULL DEFAULT 0,
  hed_min INTEGER NOT NULL DEFAULT 0,
  hen_min INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, shift_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_marks_emp_date ON attendance_marks(employee_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_attendance_marks_org ON attendance_marks(organization_id);
CREATE INDEX IF NOT EXISTS idx_attendance_alerts_org ON attendance_alerts(organization_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_attendance_days_org ON attendance_days(organization_id, shift_date);

-- Regla 8: las alertas y marcaciones no pueden ser MODIFICADAS por ningun
-- usuario (ni siquiera Super Admin) mientras el colaborador/organizacion al
-- que pertenecen siga existiendo -- esto evita falsificar el historial.
-- (No se bloquea el DELETE: si el colaborador o la organizacion se elimina
-- por completo, es correcto que su historial se elimine en cascada junto
-- con el, igual que el resto de sus datos -- bloquear eso rompia la
-- sincronizacion normal de Colaboradores.)
CREATE TRIGGER IF NOT EXISTS trg_attendance_alerts_no_update
BEFORE UPDATE ON attendance_alerts BEGIN
  SELECT RAISE(ABORT, 'Las alertas de asistencia son inmutables y no pueden modificarse.');
END;
CREATE TRIGGER IF NOT EXISTS trg_attendance_marks_no_update
BEFORE UPDATE ON attendance_marks BEGIN
  SELECT RAISE(ABORT, 'Las marcaciones de asistencia son inmutables y no pueden modificarse.');
END;
DROP TRIGGER IF EXISTS trg_attendance_alerts_no_delete;
DROP TRIGGER IF EXISTS trg_attendance_marks_no_delete;
`);

// ---------------------------------------------------------------------------
// MIGRATION: recargo nocturno por colaborador
//  - employees.night_surcharge (1 = aplica, 0 = no aplica) + motivo.
//  - attendance_days.recargo_nocturno_aplica: se congela por dia al cerrar
//    el turno, para que cambiar la configuracion del colaborador NO altere
//    retroactivamente dias ya liquidados.
// ---------------------------------------------------------------------------
const empColumns = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
if (!empColumns.includes('night_surcharge')) db.exec('ALTER TABLE employees ADD COLUMN night_surcharge INTEGER NOT NULL DEFAULT 1');
if (!empColumns.includes('night_surcharge_reason')) db.exec('ALTER TABLE employees ADD COLUMN night_surcharge_reason TEXT');

const attDayColumns = db.prepare('PRAGMA table_info(attendance_days)').all().map(c => c.name);
if (!attDayColumns.includes('recargo_nocturno_aplica')) {
  db.exec('ALTER TABLE attendance_days ADD COLUMN recargo_nocturno_aplica INTEGER NOT NULL DEFAULT 1');
}

// ---------------------------------------------------------------------------
// PERMISSIONS CATALOG (idempotent upsert)
// ---------------------------------------------------------------------------
const PERMISSIONS = [
  ['users.view', 'Ver usuarios de la organizacion'],
  ['users.create', 'Crear/invitar usuarios'],
  ['users.edit', 'Editar usuarios'],
  ['users.delete', 'Desactivar/eliminar usuarios'],
  ['users.reset_password', 'Restablecer contrasenas'],
  ['employees.view', 'Ver colaboradores'],
  ['employees.create', 'Crear colaboradores'],
  ['employees.edit', 'Editar colaboradores'],
  ['employees.delete', 'Eliminar colaboradores'],
  ['shifts.view', 'Ver turnos/planilla'],
  ['shifts.create', 'Crear turnos'],
  ['shifts.edit', 'Editar turnos'],
  ['shifts.delete', 'Eliminar turnos'],
  ['reports.view', 'Ver reportes y nomina'],
  ['settings.manage', 'Gestionar configuracion de la organizacion'],
  ['audit.view', 'Consultar auditoria de la organizacion'],
  ['attendance.view', 'Ver asistencia, historial de marcaciones y dashboard'],
  ['attendance.mark', 'Registrar marcaciones (punto de marcacion)'],
  ['attendance.view_alerts', 'Ver alertas de asistencia (llegadas tarde, excesos, etc.)'],
  ['attendance.manage', 'Administrar configuracion del modulo de asistencia'],
  ['attendance.manage_biometrics', 'Registrar y administrar perfiles biometricos faciales de colaboradores'],
  ['attendance.manage_devices', 'Registrar y administrar dispositivos autorizados para marcar asistencia'],
];

const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, code, description) VALUES (?, ?, ?)');
for (const [code, description] of PERMISSIONS) {
  insertPerm.run(uid('perm'), code, description);
}

function permIdByCode(code) {
  const row = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code);
  return row ? row.id : null;
}

// System-wide default org role templates, cloned into every new organization.
const DEFAULT_ORG_ROLES = {
  org_admin: PERMISSIONS.map(p => p[0]), // all permissions within the org
  supervisor: ['employees.view', 'employees.create', 'employees.edit', 'shifts.view', 'shifts.create', 'shifts.edit', 'reports.view', 'attendance.view', 'attendance.view_alerts'],
  empleado: ['employees.view', 'shifts.view', 'reports.view'],
};

function createDefaultRolesForOrg(organizationId) {
  const insertRole = db.prepare('INSERT INTO roles (id, organization_id, name, is_system) VALUES (?, ?, ?, 1)');
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
  const roleIds = {};
  for (const [roleName, perms] of Object.entries(DEFAULT_ORG_ROLES)) {
    const roleId = uid('role');
    insertRole.run(roleId, organizationId, roleName);
    for (const code of perms) {
      const pid = permIdByCode(code);
      if (pid) insertRolePerm.run(roleId, pid);
    }
    roleIds[roleName] = roleId;
  }
  return roleIds;
}

function getOrgRoleByName(organizationId, name) {
  return db.prepare('SELECT * FROM roles WHERE organization_id = ? AND name = ?').get(organizationId, name);
}

// ---------------------------------------------------------------------------
// MIGRATION: organizaciones creadas ANTES de este modulo ya tienen sus roles
// (org_admin, supervisor) creados con el catalogo de permisos viejo. Sin
// esto, el nuevo permiso "attendance.*" nunca aparecerian en esos roles
// aunque el codigo ya sepa exigirlos. Se ejecuta una sola vez por permiso
// gracias a INSERT OR IGNORE (no duplica ni sobreescribe nada existente).
// ---------------------------------------------------------------------------
{
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
  const existingOrgAdminRoles = db.prepare("SELECT id FROM roles WHERE name = 'org_admin' AND organization_id IS NOT NULL").all();
  const existingSupervisorRoles = db.prepare("SELECT id FROM roles WHERE name = 'supervisor' AND organization_id IS NOT NULL").all();
  const attendanceCodes = ['attendance.view', 'attendance.mark', 'attendance.view_alerts', 'attendance.manage', 'attendance.manage_biometrics', 'attendance.manage_devices'];
  const supervisorCodes = ['attendance.view', 'attendance.view_alerts'];
  for (const role of existingOrgAdminRoles) {
    for (const code of attendanceCodes) {
      const pid = permIdByCode(code);
      if (pid) insertRolePerm.run(role.id, pid);
    }
  }
  for (const role of existingSupervisorRoles) {
    for (const code of supervisorCodes) {
      const pid = permIdByCode(code);
      if (pid) insertRolePerm.run(role.id, pid);
    }
  }
}

// ---------------------------------------------------------------------------
// BOOTSTRAP: super admin role + super admin user (first run only)
// ---------------------------------------------------------------------------
let superAdminRole = db.prepare("SELECT * FROM roles WHERE organization_id IS NULL AND name = 'super_admin'").get();
if (!superAdminRole) {
  const roleId = uid('role');
  db.prepare('INSERT INTO roles (id, organization_id, name, is_system) VALUES (?, NULL, ?, 1)').run(roleId, 'super_admin');
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
  for (const [code] of PERMISSIONS) {
    const pid = permIdByCode(code);
    if (pid) insertRolePerm.run(roleId, pid);
  }
  superAdminRole = { id: roleId };
}

const existingSuperAdmin = db.prepare('SELECT * FROM users WHERE is_super_admin = 1 LIMIT 1').get();
if (!existingSuperAdmin) {
  const userId = uid('user');
  db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, is_super_admin, status)
              VALUES (?, NULL, ?, ?, 1, 'active')`)
    .run(userId, env.SUPERADMIN_EMAIL.toLowerCase(), hashPassword(env.SUPERADMIN_PASSWORD));
  db.prepare('INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (?, ?, NULL)').run(userId, superAdminRole.id);
  console.log('======================================================================');
  console.log(' Cuenta Super Admin creada:');
  console.log('   Email:    ', env.SUPERADMIN_EMAIL);
  console.log('   Password: ', env.SUPERADMIN_PASSWORD, ' (cambiala despues de iniciar sesion)');
  console.log('======================================================================');
}

// ---------------------------------------------------------------------------
// Demo data seed (moved server-side from the original client-only seedDemoData()).
// Only used when an organization explicitly requests a demo seed via the API.
// ---------------------------------------------------------------------------
function seedDemoDataForOrg(organizationId) {
  const deptRows = [
    ['dept_cocina', 'Cocina', 'fa-utensils', 0],
    ['dept_restaurante', 'Restaurante', 'fa-wine-glass', 1],
    ['dept_hotel', 'Hotel', 'fa-hotel', 2],
    ['dept_mantenimiento_jardineria', 'Mantenimiento/Jardineria', 'fa-screwdriver-wrench', 3],
    ['dept_recepcion_admin', 'Recepcion/Admin', 'fa-id-card-clip', 4],
  ];
  const insertDept = db.prepare('INSERT INTO departments (id, organization_id, name, icon, position) VALUES (?, ?, ?, ?, ?)');
  for (const [id, name, icon, position] of deptRows) {
    insertDept.run(`${id}_${organizationId}`, organizationId, name, icon, position);
  }

  const employees = [
    ['Mateo Valencia Arango', 'Chef de Cocina', 'Cocina', 'dept_cocina', 1750905],
    ['Daniela Osorio Gomez', 'Auxiliar de Cocina', 'Cocina', 'dept_cocina', 1750905],
    ['Santiago Morales Henao', 'Capitan de Meseros', 'Restaurante', 'dept_restaurante', 1750905],
    ['Camila Ruiz Londono', 'Mesera / Servicio', 'Restaurante', 'dept_restaurante', 1750905],
    ['Patricia Elena Buendia', 'Supervisora de Pisos', 'Hotel', 'dept_hotel', 1750905],
    ['Juan David Morales', 'Camarero de Habitaciones', 'Hotel', 'dept_hotel', 1750905],
    ['Jose Fernando Castrillon', 'Tecnico Mantenimiento & Jardines', 'Mantenimiento/Jardineria', 'dept_mantenimiento_jardineria', 1750905],
    ['Maria Fernanda Gomez', 'Recepcionista Principal', 'Recepcion/Admin', 'dept_recepcion_admin', 1750905],
    ['Carlos Eduardo Restrepo', 'Supervisor Administrativo', 'Recepcion/Admin', 'dept_recepcion_admin', 1750905],
  ];
  const insertEmp = db.prepare('INSERT INTO employees (organization_id, name, role, department, department_id, salary) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, role, department, departmentId, salary] of employees) {
    insertEmp.run(organizationId, name, role, department, departmentId, salary);
  }

  db.prepare(`INSERT INTO org_settings (organization_id, org_name, minimum_wage) VALUES (?, ?, ?)
              ON CONFLICT(organization_id) DO NOTHING`).run(organizationId, 'Empresa Demo', 1750905);
}

module.exports = {
  db,
  uid,
  permIdByCode,
  createDefaultRolesForOrg,
  getOrgRoleByName,
  seedDemoDataForOrg,
  PERMISSIONS,
};
