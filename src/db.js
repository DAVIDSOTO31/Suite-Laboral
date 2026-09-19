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
  supervisor: ['employees.view', 'employees.create', 'employees.edit', 'shifts.view', 'shifts.create', 'shifts.edit', 'reports.view'],
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
