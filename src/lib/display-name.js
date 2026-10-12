'use strict';
// Limpia el "nombre para el saludo" de un usuario: sin saltos de linea ni
// caracteres de control, espacios normalizados y maximo 60 caracteres.
// Devuelve null si queda vacio (se usa el nombre de la ficha o el correo).
function cleanDisplayName(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || null;
}
module.exports = { cleanDisplayName };
