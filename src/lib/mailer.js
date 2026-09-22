'use strict';
const env = require('./env');

/**
 * Envia (o, en modo "console", imprime) un correo transaccional.
 *
 * EMAIL_MODE=console  -> imprime el enlace en los logs (modo desarrollo)
 * EMAIL_MODE=smtp     -> envia el correo de verdad usando las credenciales
 *                        SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM
 *                        (por ejemplo, las de Brevo)
 */
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  // Se importa aqui adentro (no al inicio del archivo) para que el modo
  // "console" siga funcionando aunque nodemailer no este instalado todavia.
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // true solo para el puerto 465 (SSL)
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });
  return transporter;
}

async function sendMail({ to, subject, link, kind }) {
  if (env.EMAIL_MODE === 'smtp') {
    try {
      const info = await getTransporter().sendMail({
        from: env.MAIL_FROM,
        to,
        subject,
        text: `${subject}\n\n${link}`,
        html: `<p>${subject}</p><p><a href="${link}">${link}</a></p>`,
      });
      console.log('Correo enviado a', to, '- id:', info.messageId);
      return { delivered: true, mode: 'smtp', link };
    } catch (err) {
      // Si falla el envio real, lo dejamos registrado en los logs pero no
      // tumbamos la aplicacion: el enlace igual queda disponible en el log
      // para que puedas completar la accion manualmente si hace falta.
      console.error('Error enviando correo por SMTP:', err.message);
      console.log('Enlace para', to, ':', link);
      return { delivered: false, mode: 'smtp-error', link, error: err.message };
    }
  }

  if (env.EMAIL_MODE === 'console') {
    console.log('\n===================== EMAIL SIMULADO =====================');
    console.log('Para:     ', to);
    console.log('Asunto:   ', subject);
    console.log('Tipo:     ', kind);
    console.log('Enlace:   ', link);
    console.log('============================================================\n');
    return { delivered: false, mode: 'console', link };
  }

  console.warn('EMAIL_MODE distinto de "console"/"smtp". Cayendo a consola.');
  console.log('Enlace para', to, ':', link);
  return { delivered: false, mode: 'unconfigured', link };
}

module.exports = { sendMail };
