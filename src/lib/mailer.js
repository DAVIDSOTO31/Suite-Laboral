'use strict';
const env = require('./env');

/**
 * Envia (o, en modo "console", imprime) un correo transaccional.
 *
 * EMAIL_MODE=console -> imprime el enlace en los logs (modo desarrollo)
 * EMAIL_MODE=brevo   -> envia el correo de verdad usando la API HTTPS de
 *                       Brevo (no usa SMTP, porque Render bloquea los
 *                       puertos SMTP salientes en el plan gratuito)
 */
function parseSender(mailFrom) {
  const match = /^(.*?)<(.+)>$/.exec(String(mailFrom || '').trim());
  if (match) return { name: match[1].trim() || undefined, email: match[2].trim() };
  return { email: String(mailFrom || '').trim() };
}

// Convierte un enlace relativo (/accept-invite.html?token=...) en una URL
// absoluta (https://tu-app.onrender.com/accept-invite.html?token=...) para
// que funcione dentro de un correo real (los enlaces relativos no sirven
// fuera del navegador donde corre la app).
function toAbsoluteLink(link) {
  if (/^https?:\/\//i.test(link)) return link;
  const base = String(env.APP_URL || '').replace(/\/+$/, '');
  return `${base}${link}`;
}

async function sendMail({ to, subject, link, kind }) {
  const absoluteLink = toAbsoluteLink(link);

  if (env.EMAIL_MODE === 'brevo') {
    try {
      const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          sender: parseSender(env.MAIL_FROM),
          to: [{ email: to }],
          subject,
          htmlContent: `<p>${subject}</p><p><a href="${absoluteLink}">${absoluteLink}</a></p>`,
          textContent: `${subject}\n\n${absoluteLink}`,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error('Error enviando correo por Brevo API:', resp.status, JSON.stringify(data));
        console.log('Enlace para', to, ':', absoluteLink);
        return { delivered: false, mode: 'brevo-error', link: absoluteLink, error: data };
      }
      console.log('Correo enviado a', to, '- id:', data.messageId);
      return { delivered: true, mode: 'brevo', link: absoluteLink };
    } catch (err) {
      console.error('Error enviando correo por Brevo API:', err.message);
      console.log('Enlace para', to, ':', absoluteLink);
      return { delivered: false, mode: 'brevo-error', link: absoluteLink, error: err.message };
    }
  }

  if (env.EMAIL_MODE === 'console') {
    console.log('\n===================== EMAIL SIMULADO =====================');
    console.log('Para:     ', to);
    console.log('Asunto:   ', subject);
    console.log('Tipo:     ', kind);
    console.log('Enlace:   ', absoluteLink);
    console.log('============================================================\n');
    return { delivered: false, mode: 'console', link: absoluteLink };
  }

  console.warn('EMAIL_MODE distinto de "console"/"brevo". Cayendo a consola.');
  console.log('Enlace para', to, ':', absoluteLink);
  return { delivered: false, mode: 'unconfigured', link: absoluteLink };
}

module.exports = { sendMail };
