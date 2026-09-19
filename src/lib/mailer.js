'use strict';
const env = require('./env');

/**
 * Envia (o, en modo "console", imprime) un correo transaccional.
 * IMPORTANTE: este proyecto no incluye un proveedor SMTP real porque el
 * entorno de desarrollo no tiene acceso de red saliente. Para produccion,
 * reemplaza el bloque "console" por una integracion real (SendGrid, SES,
 * Postmark, Resend, etc.) usando fetch() o el SDK del proveedor.
 */
function sendMail({ to, subject, link, kind }) {
  if (env.EMAIL_MODE === 'console') {
    console.log('\n===================== EMAIL SIMULADO =====================');
    console.log('Para:     ', to);
    console.log('Asunto:   ', subject);
    console.log('Tipo:     ', kind);
    console.log('Enlace:   ', link);
    console.log('============================================================\n');
    return { delivered: false, mode: 'console', link };
  }
  // TODO: integrar proveedor real de email en produccion.
  console.warn('EMAIL_MODE distinto de "console" pero no hay proveedor configurado. Cayendo a consola.');
  console.log('Enlace para', to, ':', link);
  return { delivered: false, mode: 'unconfigured', link };
}

module.exports = { sendMail };
