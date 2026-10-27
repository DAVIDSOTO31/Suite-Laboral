'use strict';
// Filtros de selección múltiple: un solo valor ("Cocina") o varios en JSON
// (["Cocina","Servicio"]). Devuelve un Set, o null = sin filtro (todos).
function parseListParam(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  let list = [raw];
  if (raw.startsWith('[')) { try { const j = JSON.parse(raw); list = Array.isArray(j) ? j.map(String) : [raw]; } catch { list = [raw]; } }
  list = list.map(x => x.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}
module.exports = { parseListParam };
