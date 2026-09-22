'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

loadEnv();

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  SESSION_SECRET: process.env.SESSION_SECRET || 'INSECURE_DEV_SECRET_CHANGE_ME',
  SESSION_TTL_HOURS: parseFloat(process.env.SESSION_TTL_HOURS || '12'),
  DB_PATH: process.env.DB_PATH || './data/app.db',
  SUPERADMIN_EMAIL: process.env.SUPERADMIN_EMAIL || 'superadmin@tuempresa.com',
  SUPERADMIN_PASSWORD: process.env.SUPERADMIN_PASSWORD || 'CambiaEstaClave123!',
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || '',
  EMAIL_MODE: process.env.EMAIL_MODE || 'console',
  // API HTTPS de Brevo (no SMTP): https://api.brevo.com/v3/smtp/email
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  MAIL_FROM: process.env.MAIL_FROM || 'RR.HH PYMES <no-reply@example.com>',
  // Direccion base publica de tu app, sin barra al final, ej: https://rr-hh-pymes-suite-laboral.onrender.com
  APP_URL: process.env.APP_URL || '',
};
