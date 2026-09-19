'use strict';
const { db, uid } = require('../db');

const insertStmt = db.prepare(`
  INSERT INTO audit_logs (id, organization_id, user_id, action, resource_type, resource_id, metadata_json, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

/**
 * Registra una accion de auditoria.
 * @param {object} opts
 * @param {string|null} opts.organizationId
 * @param {string|null} opts.userId
 * @param {string} opts.action - ej. "user.login", "employee.create"
 * @param {string} [opts.resourceType]
 * @param {string|number} [opts.resourceId]
 * @param {object} [opts.metadata]
 * @param {string} [opts.ip]
 */
function logAction(opts) {
  try {
    insertStmt.run(
      uid('audit'),
      opts.organizationId || null,
      opts.userId || null,
      opts.action,
      opts.resourceType || null,
      opts.resourceId != null ? String(opts.resourceId) : null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      opts.ip || null
    );
  } catch (e) {
    // Auditing must never crash the request that triggered it.
    console.error('audit log failed:', e.message);
  }
}

module.exports = { logAction };
