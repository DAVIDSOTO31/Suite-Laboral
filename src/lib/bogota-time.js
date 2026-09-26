'use strict';

/**
 * Utilidad AISLADA para la "hora oficial" del modulo de asistencia.
 * Colombia usa UTC-5 todo el ano (no tiene horario de verano), por lo que el
 * desfase es constante -- esto evita depender de bases de datos de zona
 * horaria del sistema operativo, que a veces faltan en imagenes minimas de
 * Docker.
 *
 * REGLA 24 del documento: "las marcaciones deben utilizar la hora oficial
 * del servidor, no la del dispositivo del empleado". Esta funcion es la
 * unica fuente de verdad de "que hora es ahora mismo en Bogota".
 */
const BOGOTA_UTC_OFFSET_HOURS = 5;

// "2026-09-26" -> instante UTC (ms) que corresponde a las 00:00:00 de ese
// dia en Bogota.
function bogotaMidnightUTCms(dateISO) {
  return Date.parse(`${dateISO}T00:00:00.000Z`) + BOGOTA_UTC_OFFSET_HOURS * 3600000;
}

// Fecha ISO (YYYY-MM-DD) del "hoy" en Bogota, para un instante dado (por
// defecto, el instante actual del servidor).
function todayISOInBogota(now = new Date()) {
  const shifted = new Date(now.getTime() - BOGOTA_UTC_OFFSET_HOURS * 3600000);
  return shifted.toISOString().slice(0, 10);
}

// Suma (o resta) dias a una fecha ISO simple (sin horas), en aritmetica de
// calendario (no le importa la zona horaria, solo cuenta dias).
function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Minutos transcurridos entre la medianoche de `shiftDateISO` (hora Bogota)
// y el instante `now`. Este es el mismo "sistema de referencia" que usa
// attendance-rules.js (0 = medianoche del dia del turno), por lo que un
// turno nocturno que cruza medianoche simplemente da un numero > 1440, sin
// necesidad de logica especial aqui.
function minutesSinceShiftMidnight(now, shiftDateISO) {
  return Math.round((now.getTime() - bogotaMidnightUTCms(shiftDateISO)) / 60000);
}

module.exports = {
  BOGOTA_UTC_OFFSET_HOURS,
  todayISOInBogota,
  addDaysISO,
  minutesSinceShiftMidnight,
};
