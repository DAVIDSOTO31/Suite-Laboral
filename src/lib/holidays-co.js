'use strict';
// Festivos de Colombia (misma regla que la suite en el navegador):
//  - Fijos: 1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic.
//  - Ley Emiliani (al lunes siguiente): 6 ene, 19 mar, 29 jun, 15 ago, 12 oct,
//    1 nov, 11 nov y, desde 2026 (Ley 2578), 9 jul.
//  - Segun la Pascua: Jueves y Viernes Santo; Ascension, Corpus Christi y
//    Sagrado Corazon (trasladados a lunes).
const cache = {};
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
function holidaysCO(year) {
  if (cache[year]) return cache[year];
  const set = new Set();
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const add = (dt) => set.add(iso(dt));
  const toMonday = (dt) => { const r = new Date(dt); while (r.getUTCDay() !== 1) r.setUTCDate(r.getUTCDate() + 1); return r; };
  const plus = (dt, n) => { const r = new Date(dt); r.setUTCDate(r.getUTCDate() + n); return r; };
  const D = (m, d) => new Date(Date.UTC(year, m, d));
  [D(0, 1), D(4, 1), D(6, 20), D(7, 7), D(11, 8), D(11, 25)].forEach(add);
  [D(0, 6), D(2, 19), D(5, 29), D(7, 15), D(9, 12), D(10, 1), D(10, 11)].forEach(dt => add(toMonday(dt)));
  if (year >= 2026) add(toMonday(D(6, 9)));
  const easter = easterSunday(year);
  add(plus(easter, -3)); add(plus(easter, -2));
  add(plus(easter, 43)); add(plus(easter, 64)); add(plus(easter, 71));
  cache[year] = set;
  return set;
}
function isHolidayCO(dateISO) { return holidaysCO(Number(String(dateISO).slice(0, 4))).has(String(dateISO).slice(0, 10)); }
module.exports = { holidaysCO, isHolidayCO };
