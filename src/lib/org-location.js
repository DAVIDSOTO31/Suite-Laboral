'use strict';
// Ubicación de la organización (ciudad y departamento), registrada por el
// Super Admin. Se usa en la fecha de todos los documentos que genera la suite
// (llamados de atención, certificados laborales...).
const { db } = require('../db');

const DEPARTAMENTOS = ['Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bogotá D.C.', 'Bolívar', 'Boyacá', 'Caldas', 'Caquetá', 'Casanare', 'Cauca', 'Cesar', 'Chocó',
  'Córdoba', 'Cundinamarca', 'Guainía', 'Guaviare', 'Huila', 'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander', 'Putumayo', 'Quindío', 'Risaralda',
  'San Andrés y Providencia', 'Santander', 'Sucre', 'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada'];

{
  const cols = db.prepare('PRAGMA table_info(organizations)').all().map(c => c.name);
  if (!cols.includes('city')) db.exec('ALTER TABLE organizations ADD COLUMN city TEXT');
  if (!cols.includes('state')) db.exec('ALTER TABLE organizations ADD COLUMN state TEXT');
}

// "Pereira, Risaralda" · "Bogotá D.C." · '' si no está registrada.
function formatLocation(city, state) {
  const c = String(city || '').trim(), s = String(state || '').trim();
  if (!c && !s) return '';
  if (s === 'Bogotá D.C.' || !s || c.toLowerCase() === s.toLowerCase()) return c || s;
  return c ? `${c}, ${s}` : s;
}
function orgLocation(orgId) {
  const o = db.prepare('SELECT city, state FROM organizations WHERE id = ?').get(orgId);
  return o ? formatLocation(o.city, o.state) : '';
}

module.exports = { DEPARTAMENTOS, formatLocation, orgLocation };
