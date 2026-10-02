'use strict';
// Pruebas del motor de horas (recargo nocturno / extras).
// Ejecutar con:  node --test tests/attendance-rules.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/lib/attendance-rules');
const t = r.timeToMinutes;

test('Recargo solo hasta la salida programada; lo demas es extra nocturna', () => {
  const out = r.categorizeWorkedMinutes({
    scheduledEntradaMin: t('13:40'), scheduledSalidaMin: t('22:00'),
    actualEntradaMin: t('13:40'), actualSalidaMin: t('22:05'), breakMinutes: 20,
  });
  assert.deepEqual(out, { hod: 300, hon: 180, hed: 0, hen: 5 });
});

test('El almuerzo nunca reduce el recargo nocturno', () => {
  const out = r.categorizeWorkedMinutes({
    scheduledEntradaMin: t('14:00'), scheduledSalidaMin: t('22:00'),
    actualEntradaMin: t('14:00'), actualSalidaMin: t('22:00'), breakMinutes: 60,
  });
  assert.equal(out.hon, 180);
  assert.equal(out.hod, 240);
});

test('Turno nocturno completo: recargo completo aunque almuerce de noche', () => {
  const out = r.categorizeWorkedMinutes({
    scheduledEntradaMin: t('22:00'), scheduledSalidaMin: t('06:00') + 1440,
    actualEntradaMin: t('21:50'), actualSalidaMin: t('06:30') + 1440, breakMinutes: 30,
  });
  assert.deepEqual(out, { hod: 0, hon: 480, hed: 30, hen: 0 });
});

test('Colaborador sin recargo: el nocturno ordinario pasa a ordinario simple', () => {
  const out = r.categorizeWorkedMinutes({
    scheduledEntradaMin: t('13:40'), scheduledSalidaMin: t('22:00'),
    actualEntradaMin: t('13:40'), actualSalidaMin: t('22:05'), breakMinutes: 20,
    nightSurchargeEnabled: false,
  });
  assert.deepEqual(out, { hod: 480, hon: 0, hed: 0, hen: 5 });
});
