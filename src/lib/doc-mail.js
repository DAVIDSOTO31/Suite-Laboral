'use strict';
// Correo de los documentos laborales (llamados de atencion y certificados):
// mensaje corto, boton al enlace seguro y el PDF adjunto.
const { sendMail } = require('./mailer');
const env = require('./env');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// PDF enviado por la suite (base64, con o sin "data:application/pdf;base64,").
// Devuelve el base64 limpio o null si no es un PDF valido (max. 4 MB).
function cleanPdf(raw) {
  const b64 = String(raw || '').replace(/^data:application\/pdf[^,]*,/, '').replace(/\s/g, '');
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64) || !b64.startsWith('JVBER')) return null; // "%PDF"
  if (b64.length * 3 / 4 > 4 * 1024 * 1024) return null;
  return b64;
}
function safeFileName(name, fallback) {
  const n = String(name || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
  return /\.pdf$/i.test(n) ? n : (n ? n + '.pdf' : fallback);
}

// lines: parrafos del mensaje (texto plano). link: ruta relativa del enlace seguro.
async function sendDocEmail({ to, subject, orgName, lines, link, buttonLabel, pdf, fileName }) {
  const abs = /^https?:\/\//i.test(link) ? link : String(env.APP_URL || '').replace(/\/+$/, '') + link;
  const bodyHtml = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;line-height:1.5;max-width:560px">
    <p style="font-weight:bold;font-size:16px;margin:0 0 12px">${esc(orgName)}</p>
    ${lines.map(l => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('')}
    <p style="margin:18px 0"><a href="${esc(abs)}" style="background:#0284c7;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold;display:inline-block">${esc(buttonLabel)}</a></p>
    ${pdf ? '<p style="margin:0 0 10px;color:#475569;font-size:12px">El documento también va adjunto en PDF.</p>' : ''}
    <p style="margin:16px 0 0;color:#94a3b8;font-size:11px">Este correo lo envió ${esc(orgName)} desde su sistema de Recursos Humanos. Si el botón no abre, copia este enlace en el navegador:</p>
  </div>`;
  const bodyText = `${orgName}\n\n${lines.join('\n\n')}\n\n${buttonLabel}:`;
  return sendMail({ to, subject, link: abs, kind: 'documento', bodyHtml, bodyText, attachments: pdf ? [{ name: fileName, content: pdf }] : [] });
}

module.exports = { EMAIL_RE, cleanPdf, safeFileName, sendDocEmail };
