'use strict';

/**
 * Motor de reglas de asistencia (RR.HH PYMES).
 *
 * Modulo NUEVO Y AISLADO: no importa ni modifica ningun otro archivo del
 * proyecto. Son funciones puras (mismo input -> mismo output, sin efectos
 * secundarios), pensadas para poder probarse solas antes de conectarlas a
 * la base de datos o a la interfaz.
 *
 * Convenciones de nombres de horas (se reutilizan las mismas siglas que ya
 * usa el modulo de Cuadro de Turnos / Liquidacion de la app, para que en el
 * futuro sea facil conectarlas):
 *   hod = Horas Ordinarias Diurnas
 *   hon = Horas Ordinarias Nocturnas (recargo nocturno ordinario)
 *   hed = Horas Extra Diurnas
 *   hen = Horas Extra Nocturnas
 *
 * Ventana nocturna legal usada por esta suite: 19:00 - 06:00 (la misma que
 * ya se muestra en el encabezado de la app: "Ley 2466: Noche 19:00 - 06:00").
 */

const NIGHT_START_MIN = 19 * 60; // 19:00
const NIGHT_END_MIN = 6 * 60;    // 06:00
const PREVENTIVE_WINDOW_MIN = 5; // alerta preventiva: 5 minutos antes de la entrada
// Barrera para activar las horas extras: si el tiempo trabajado despues de la
// salida programada (diurno + nocturno) es MENOR a 30 minutos, no se reconoce
// como extra. Si llega a 30 minutos o mas, se reconoce TODO desde la hora en
// que terminaba el turno.
const OVERTIME_THRESHOLD_MIN = 30;

const MARK_SEQUENCE = ['entrada', 'inicio_almuerzo', 'fin_almuerzo', 'salida'];

// ---------------------------------------------------------------------------
// Utilidades basicas de tiempo
// ---------------------------------------------------------------------------

// "08:00" -> 480 (minutos desde medianoche). Devuelve null si el formato no es valido.
function timeToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h < 0 || h > 29 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

// 95 -> "1h 35min". Conserva el signo (utiles para saldos negativos).
function formatMinutes(totalMinutes) {
  const sign = totalMinutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(totalMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}min`;
  return `${sign}${h}h ${m}min`;
}

// Dado un reloj programado (ej. "22:00") y el reloj programado de referencia
// de ENTRADA del turno (para saber si ya cruzo medianoche), calcula los
// minutos absolutos desde el inicio del turno (puede superar 1440 si cruza
// la medianoche). Esto permite comparar horas de un turno nocturno sin
// confundir "06:00" (salida) con "06:00 del mismo dia que la entrada".
function scheduledAbsoluteMinutes(scheduledHHMM, entradaHHMM) {
  const t = timeToMinutes(scheduledHHMM);
  const entrada = timeToMinutes(entradaHHMM);
  if (t == null || entrada == null) return null;
  // Si el reloj programado es "menor" que la hora de entrada, asumimos que
  // pertenece al dia siguiente (turno que cruza medianoche).
  return t < entrada ? t + 1440 : t;
}

// NOTA: la conversion de una marca de tiempo REAL (Date) a "minutos desde la
// medianoche del turno" se hace en la capa de rutas (attendance.routes.js),
// usando src/lib/bogota-time.js, que si maneja correctamente la zona horaria
// America/Bogota. Este archivo se mantiene 100% puro (solo numeros enteros
// de minutos, sin fechas), precisamente para que ese calculo de zona horaria
// no pueda filtrarse aqui por error.

// ---------------------------------------------------------------------------
// Secuencia de marcaciones (evita duplicados / orden invalido)
// ---------------------------------------------------------------------------

// marksToday: arreglo de mark_type ya registrados hoy para ese empleado, en
// el orden en que se guardaron. Devuelve el siguiente tipo esperado, o null
// si el turno ya esta completo (las 4 marcaciones ya se hicieron).
function nextExpectedMarkType(marksToday) {
  const done = new Set(marksToday);
  for (const type of MARK_SEQUENCE) {
    if (!done.has(type)) return type;
  }
  return null;
}

// Valida si el tipo de marca solicitado es el que corresponde ahora mismo.
function validateMarkSequence(marksToday, requestedType) {
  const expected = nextExpectedMarkType(marksToday);
  if (expected === null) {
    return { valid: false, reason: 'El turno de hoy ya tiene las 4 marcaciones completas.', expected: null };
  }
  if (requestedType && requestedType !== expected) {
    return { valid: false, reason: `La siguiente marcacion esperada es "${expected}", no "${requestedType}".`, expected };
  }
  return { valid: true, expected };
}

// ---------------------------------------------------------------------------
// Clasificacion de cada marcacion (reglas 4, 5, 6, 7, 9, 10, 11 del documento)
// ---------------------------------------------------------------------------

// Entrada: >= hora programada => tarde (sin redondeos). < hora programada => anticipada.
function classifyEntrada(scheduledMin, actualMin) {
  const diff = actualMin - scheduledMin; // positivo = tarde, negativo = anticipado
  if (diff >= 0) {
    return { status: 'tarde', diffMinutes: diff };
  }
  return { status: 'anticipada', diffMinutes: diff }; // diffMinutes negativo
}

// Alerta preventiva: 5 minutos antes de la entrada programada, siempre que
// todavia no exista marca de entrada. `nowMin` y `scheduledMin` en minutos
// absolutos del turno (ver scheduledAbsoluteMinutes / actualAbsoluteMinutes).
function isPreventiveWindow(nowMin, scheduledEntradaMin) {
  return nowMin >= (scheduledEntradaMin - PREVENTIVE_WINDOW_MIN) && nowMin < scheduledEntradaMin;
}

// Almuerzo: compara duracion real contra duracion permitida (en minutos).
function classifyAlmuerzo(allowedBreakMinutes, actualBreakMinutes) {
  const excess = actualBreakMinutes - allowedBreakMinutes;
  return { excessMinutes: Math.max(0, excess), actualBreakMinutes };
}

// Salida: si la marca real es ANTES de la hora programada, hay minutos adeudados.
function classifySalida(scheduledMin, actualMin) {
  const adeudado = Math.max(0, scheduledMin - actualMin);
  return { adeudadoMinutes: adeudado };
}

// ---------------------------------------------------------------------------
// Categorizacion de horas trabajadas (regla 14): hod / hon / hed / hen
// ---------------------------------------------------------------------------

// Minutos de un intervalo [fromMin, toMin) (minutos absolutos del turno, ya
// normalizados con scheduledAbsoluteMinutes/actualAbsoluteMinutes) que caen
// dentro de la ventana nocturna 19:00-06:00. Funciona aunque el intervalo
// cruce varias medianoches relativas (turnos largos).
function nightMinutesInInterval(fromMin, toMin) {
  if (toMin <= fromMin) return 0;
  let night = 0;
  // Recorremos dia por dia (0..N) dentro del intervalo, sumando la parte
  // nocturna de cada dia relativo al turno.
  const startDay = Math.floor(fromMin / 1440);
  const endDay = Math.floor((toMin - 1) / 1440);
  for (let day = startDay; day <= endDay; day++) {
    const dayBase = day * 1440;
    // Ventana nocturna de ESTE dia: [dayBase+19:00, dayBase+24:00) y
    // [dayBase, dayBase+06:00) (la madrugada pertenece a la noche que
    // empezo el dia anterior, pero para sumar minutos basta partir el dia
    // en dos tramos nocturnos: 00:00-06:00 y 19:00-24:00).
    const seg1From = Math.max(fromMin, dayBase);
    const seg1To = Math.min(toMin, dayBase + NIGHT_END_MIN);
    if (seg1To > seg1From) night += seg1To - seg1From;

    const seg2From = Math.max(fromMin, dayBase + NIGHT_START_MIN);
    const seg2To = Math.min(toMin, dayBase + 1440);
    if (seg2To > seg2From) night += seg2To - seg2From;
  }
  return night;
}

/**
 * Calcula hod/hon/hed/hen (en MINUTOS ENTEROS) para un turno.
 * Todos los valores van en el mismo sistema de referencia: minutos desde la
 * medianoche (hora Bogota) del dia del turno; un turno que cruza medianoche
 * simplemente da valores > 1440.
 *
 *   - scheduledEntradaMin, scheduledSalidaMin: turno programado
 *   - actualEntradaMin, actualSalidaMin: marcas reales
 *   - breakMinutes: duracion del almuerzo (real si se marco, si no la programada)
 *   - nightSurchargeEnabled: si es false, el tiempo ordinario nocturno se
 *     reporta como ordinario diurno (hod) y hon queda en 0. Las horas extra
 *     nocturnas (hen) NO se ven afectadas.
 *
 * Reglas:
 *   - Jornada ordinaria = desde max(entrada real, entrada programada) hasta
 *     min(salida real, salida programada). Solo ahi se cuenta el recargo
 *     nocturno (hon).
 *   - Lo trabajado DESPUES de la salida programada es hora extra: hed (dia)
 *     o hen (noche, 19:00-06:00).
 *   - Lo trabajado ANTES de la entrada programada no se computa.
 *   - Politica de la organizacion: el almuerzo NUNCA reduce el recargo
 *     nocturno, sin importar si se tomo de dia o de noche. Se descuenta solo
 *     de las horas ordinarias diurnas (hod); el recargo nocturno se paga
 *     completo.
 */
function categorizeWorkedMinutes({
  scheduledEntradaMin, scheduledSalidaMin, actualEntradaMin, actualSalidaMin,
  breakMinutes = 0, nightSurchargeEnabled = true,
}) {
  const workStart = Math.max(actualEntradaMin, scheduledEntradaMin);
  const workEnd = Math.max(workStart, actualSalidaMin);

  const ordinaryEnd = Math.min(workEnd, scheduledSalidaMin);
  const ordinaryGross = Math.max(0, ordinaryEnd - workStart);
  const ordinaryNight = ordinaryGross > 0 ? nightMinutesInInterval(workStart, ordinaryEnd) : 0;
  let hod = Math.max(0, ordinaryGross - ordinaryNight);
  let hon = ordinaryNight;

  const extraStart = Math.max(workStart, scheduledSalidaMin);
  const extraGross = Math.max(0, workEnd - extraStart);
  const extraNight = extraGross > 0 ? nightMinutesInInterval(extraStart, workEnd) : 0;
  let extraDay = Math.max(0, extraGross - extraNight);
  let extraNightFinal = extraNight;
  if (extraDay + extraNightFinal < OVERTIME_THRESHOLD_MIN) {
    extraDay = 0;
    extraNightFinal = 0;
  }

  hod -= Math.min(hod, Math.max(0, breakMinutes || 0));

  if (!nightSurchargeEnabled) {
    hod += hon;
    hon = 0;
  }

  return {
    hod: Math.max(0, Math.round(hod)),
    hon: Math.max(0, Math.round(hon)),
    hed: Math.round(extraDay),
    hen: Math.round(extraNightFinal),
  };
}

// ---------------------------------------------------------------------------
// TURNO PARTIDO: las primeras horas TRABAJADAS (hasta el limite diario del
// turno) son ordinarias y las ultimas son extra, sumando la etapa 1 y luego la
// etapa 2. Asi, si la etapa 1 se alarga, la ultima parte de la etapa 2 pasa a
// ser tiempo extra. Lo trabajado antes de la entrada programada no se computa.
// La barrera de 30 minutos aplica igual. Todos los valores en minutos
// absolutos desde la medianoche del dia del turno.
// ---------------------------------------------------------------------------
function categorizeSplitWorkedMinutes({
  scheduledEntradaMin, stage1Start, stage1End, stage2Start, stage2End,
  limitMinutes = 480, nightSurchargeEnabled = true,
}) {
  const s1from = Math.max(stage1Start, scheduledEntradaMin);
  const s1to = Math.max(s1from, stage1End);
  const s2from = Math.max(s1to, stage2Start);
  const s2to = Math.max(s2from, stage2End);
  let remaining = Math.max(0, limitMinutes);
  let hod = 0, hon = 0, extraDay = 0, extraNight = 0, worked = 0;
  for (const [a, b] of [[s1from, s1to], [s2from, s2to]]) {
    const len = b - a;
    if (len <= 0) continue;
    worked += len;
    const ord = Math.min(len, remaining);
    remaining -= ord;
    if (ord > 0) {
      const n = nightMinutesInInterval(a, a + ord);
      hon += n; hod += ord - n;
    }
    if (len > ord) {
      const n = nightMinutesInInterval(a + ord, b);
      extraNight += n; extraDay += (len - ord) - n;
    }
  }
  if (extraDay + extraNight < OVERTIME_THRESHOLD_MIN) { extraDay = 0; extraNight = 0; }
  if (!nightSurchargeEnabled) { hod += hon; hon = 0; }
  return { hod: Math.round(hod), hon: Math.round(hon), hed: Math.round(extraDay), hen: Math.round(extraNight), worked: Math.round(worked) };
}

// ---------------------------------------------------------------------------
// Regla 12/13: el tiempo adeudado por salida anticipada se descuenta SIEMPRE
// de las horas extra diurnas (hed), y puede dejarlas en saldo negativo.
// Nunca se toca hen ni hon.
// ---------------------------------------------------------------------------
function applyEarlyLeaveDeduction(hed, adeudadoMinutes) {
  return hed - adeudadoMinutes; // puede quedar negativo a proposito
}

module.exports = {
  NIGHT_START_MIN,
  NIGHT_END_MIN,
  PREVENTIVE_WINDOW_MIN,
  OVERTIME_THRESHOLD_MIN,
  MARK_SEQUENCE,
  timeToMinutes,
  formatMinutes,
  scheduledAbsoluteMinutes,
  nextExpectedMarkType,
  validateMarkSequence,
  classifyEntrada,
  isPreventiveWindow,
  classifyAlmuerzo,
  classifySalida,
  nightMinutesInInterval,
  categorizeWorkedMinutes,
  categorizeSplitWorkedMinutes,
  applyEarlyLeaveDeduction,
};
