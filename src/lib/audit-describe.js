'use strict';
// ---------------------------------------------------------------------------
// AUDITORIA EN ESPAÑOL
// Convierte cada registro tecnico de la auditoria en una descripcion clara de
// lo que hizo la persona: QUE accion, SOBRE QUIEN o QUE, y con QUE detalle.
// Devuelve { category, title, text, details[], actorFallback }.
// ---------------------------------------------------------------------------

const MARK_ES = { entrada: 'la entrada', inicio_almuerzo: 'el inicio de almuerzo', fin_almuerzo: 'el fin de almuerzo', salida: 'la salida' };
const MARK_SPLIT_ES = { entrada: 'el inicio de la etapa 1', inicio_almuerzo: 'el final de la etapa 1', fin_almuerzo: 'el inicio de la etapa 2', salida: 'el final de la etapa 2' };
const MARK_FIELD_ES = { entrada: 'Entrada', inicio_almuerzo: 'Inicio de almuerzo', fin_almuerzo: 'Fin de almuerzo', salida: 'Salida' };
const ROLE_ES = { org_admin: 'Administrador', supervisor: 'Supervisor', empleado: 'Empleado' };
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function dmy(iso) { return iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '-'; }
function dayName(iso) {
  if (!iso) return '-';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${dmy(iso)}`;
}
function money(v) { const n = Math.round(Number(v) || 0); return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('es-CO'); }
function hm(h) {
  const v = Number(h) || 0, sign = v < 0 ? '-' : '', t = Math.round(Math.abs(v) * 60);
  return `${sign}${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} h`;
}
function val(v) { return v === null || v === undefined || v === '' ? '(vacío)' : String(v); }

function describeAudit(row, ctx = {}) {
  const m = row.metadata || {};
  const empName = (id) => (ctx.employees && ctx.employees.get(String(id))) || m.colaborador || m.employeeName || 'un colaborador';
  const userEmail = (id) => { const u = ctx.users && ctx.users.get(id); return u ? u.email : 'un usuario'; };
  const out = (category, title, text, details = [], actorFallback) => ({ category, title, text, details, actorFallback });

  switch (row.action) {
    // ---------------- Sesión ----------------
    case 'auth.login': return out('Sesión', 'Inicio de sesión', 'Inició sesión en la suite.');
    case 'backup.verified': return out('Configuración', 'Verificación de copia de seguridad', `Verificó la copia de seguridad en la nube: ${m.resultado || 'sin resultado'}.${m.mensaje ? ' ' + m.mensaje : ''}`);
    case 'auth.logout': return out('Sesión', 'Cierre de sesión', 'Cerró sesión.');
    case 'auth.login_failed': return out('Sesión', 'Intento fallido', `Intento de inicio de sesión fallido con el correo ${val(m.email)}.`, [], m.email || 'Desconocido');
    case 'auth.invite_accepted': return out('Sesión', 'Invitación aceptada', 'Aceptó la invitación y creó su contraseña.');
    case 'auth.password_reset_requested': return out('Sesión', 'Recuperar contraseña', 'Solicitó un enlace para recuperar su contraseña.', [], m.email);
    case 'auth.password_reset_completed': return out('Sesión', 'Contraseña cambiada', 'Cambió su contraseña con el enlace de recuperación.');

    // ---------------- Usuarios ----------------
    case 'user.invite': return out('Usuarios', 'Invitación de usuario',
      `Invitó a ${val(m.email)} a la suite como ${ROLE_ES[m.role] || m.role || 'usuario'}${m.employee ? `, vinculado al colaborador ${m.employee}` : ''}${m.nombreSaludo ? `, con nombre para el saludo "${m.nombreSaludo}"` : ''}.`);
    case 'user.update': {
      const who = m.usuario || userEmail(row.resource_id);
      const parts = [];
      if (m.rolNuevo || m.role) parts.push(`cambió su rol a ${ROLE_ES[m.rolNuevo || m.role] || m.rolNuevo || m.role}`);
      if (Object.prototype.hasOwnProperty.call(m, 'colaboradorVinculado')) parts.push(m.colaboradorVinculado ? `lo vinculó con el colaborador ${m.colaboradorVinculado}` : 'lo desvinculó de su ficha de colaborador');
      else if (Object.prototype.hasOwnProperty.call(m, 'employeeId')) parts.push(m.employeeId ? `lo vinculó con el colaborador ${empName(m.employeeId)}` : 'lo desvinculó de su ficha de colaborador');
      if (Object.prototype.hasOwnProperty.call(m, 'nombreSaludo')) parts.push(m.nombreSaludo ? `cambió su nombre para el saludo a "${m.nombreSaludo}"` : 'quitó su nombre para el saludo (se usa el de su ficha)');
      return out('Usuarios', 'Usuario modificado', `Modificó el usuario ${who}: ${parts.join(' y ') || 'actualizó sus datos'}.`);
    }
    case 'user.activate': return out('Usuarios', 'Usuario activado', `Activó el usuario ${m.usuario || userEmail(row.resource_id)}.`);
    case 'user.deactivate': return out('Usuarios', 'Usuario desactivado', `Desactivó el usuario ${m.usuario || userEmail(row.resource_id)}; ya no puede iniciar sesión.`);
    case 'user.reset_password_requested': return out('Usuarios', 'Restablecer contraseña', `Envió un enlace para restablecer la contraseña de ${m.usuario || userEmail(row.resource_id)}.`);
    case 'user.auto_linked': return out('Usuarios', 'Vinculación automática', `El usuario ${val(m.email)} quedó vinculado automáticamente con el colaborador ${val(m.employeeName)} (mismo correo).`);
    case 'user.delete': return out('Usuarios', 'Usuario eliminado', `Eliminó el usuario ${m.email || userEmail(row.resource_id)}.`);

    // ---------------- Colaboradores ----------------
    case 'employee.created': return out('Colaboradores', 'Colaborador creado',
      `Creó la ficha de ${val(m.colaborador)}${m.cargo ? `, ${m.cargo}` : ''}${m.area ? `, área ${m.area}` : ''}.`,
      [m.documento ? `Documento: ${m.documento}` : null, m.correo ? `Correo: ${m.correo}` : null, m.celular ? `Celular: ${m.celular}` : null, m.salario ? `Salario: ${money(m.salario)}` : null].filter(Boolean));
    case 'employee.updated': {
      const c = m.cambios || [];
      return out('Colaboradores', 'Ficha modificada', `Modificó la ficha de ${val(m.colaborador)}: ${c.map(x => x.campo.toLowerCase()).join(', ')}.`,
        c.map(x => `${x.campo}: ${x.campo === 'Salario' ? money(x.antes) : val(x.antes)} → ${x.campo === 'Salario' ? money(x.despues) : val(x.despues)}`));
    }
    case 'employee.deleted': return out('Colaboradores', 'Colaborador eliminado', `Eliminó la ficha del colaborador ${val(m.colaborador)}${m.sinHistorial ? ' (no tenía marcaciones ni liquidaciones)' : ''}.`);
    case 'employee.retired': return out('Colaboradores', 'Colaborador retirado',
      `Retiró a ${val(m.colaborador)} con último día laborado el ${dmy(m.fecha)}${m.automatico ? ' (al quitarlo de la lista; su historial se conservó)' : ''}.`,
      [m.motivo ? `Motivo: ${m.motivo}${m.detalle ? ` — ${m.detalle}` : ''}` : null, m.turnosQuitados ? `Se quitaron ${m.turnosQuitados} turno(s) posteriores al retiro` : null,
        m.perfilFacialBorrado ? 'Se borró su perfil facial (dato biométrico)' : null, m.usuarioDesactivado ? `Se desactivó su usuario ${m.usuarioDesactivado}` : null].filter(Boolean));
    case 'employee.reactivated': return out('Colaboradores', 'Colaborador reintegrado',
      `Reactivó a ${val(m.colaborador)}${m.retiroAnterior ? ` (estaba retirado desde el ${dmy(m.retiroAnterior)})` : ''}.`);
    case 'employee.night_surcharge_changed': return out('Colaboradores', 'Recargo nocturno', `${m.aplica ? 'Activó' : 'Desactivó'} el recargo nocturno de ${val(m.employeeName)}.`, m.motivo ? [`Motivo: ${m.motivo}`] : []);
    case 'employee.count_worked_days_changed': return out('Colaboradores', 'Días laborados', `${m.contabiliza ? 'Activó' : 'Desactivó'} el conteo de días laborados de ${val(m.employeeName)}.`);

    // ---------------- Turnos ----------------
    case 'shifts.changed': {
      const c = m.cambios || [];
      const total = m.total || c.length;
      const one = c.length === 1 ? c[0] : null;
      const text = one
        ? `Cambió el turno de ${val(m.colaborador)} del ${dayName(one.fecha)}: ${one.antes} → ${one.despues}.`
        : `Modificó ${total} turno(s) de ${val(m.colaborador)} entre el ${dmy(c[0] && c[0].fecha)} y el ${dmy(c[c.length - 1] && c[c.length - 1].fecha)}.`;
      return out('Turnos', 'Turnos modificados', text, one ? [] : c.map(x => `${dayName(x.fecha)}: ${x.antes} → ${x.despues}`).concat(total > c.length ? [`… y ${total - c.length} más`] : []));
    }
    case 'shifts.published': return out('Turnos', 'Cuadro publicado',
      `Publicó el cuadro de turnos del ${dmy(m.desde)} al ${dmy(m.hasta)}.`,
      [`Horario enviado por correo a ${m.notificados || 0} colaborador(es)${m.sinCorreo ? `; ${m.sinCorreo} sin correo registrado` : ''}.`]);
    case 'shifts.published_changed': return out('Turnos', 'Turnos publicados modificados', `Cambió ${m.cambios || 0} turno(s) que ya estaban publicados.`);
    case 'shift_presets.replace': {
      const d = [];
      (m.creados || []).forEach(x => d.push(`Creó: ${x}`));
      (m.editados || []).forEach(x => d.push(`Editó: ${x.antes} → ${x.despues}`));
      (m.eliminados || []).forEach(x => d.push(`Eliminó: ${x}`));
      return out('Turnos', 'Turnos predeterminados', d.length ? `Modificó los turnos predeterminados (${d.length} cambio(s)).` : `Actualizó los turnos predeterminados (${m.count || 0}).`, d);
    }
    case 'rotation_patterns.replace': return out('Turnos', 'Patrones de rotación', `Actualizó los patrones de rotación guardados (${m.count || 0}).`);

    // ---------------- Asistencia ----------------
    case 'attendance.mark': {
      const label = (m.isSplit ? MARK_SPLIT_ES : MARK_ES)[m.markType] || 'una marcación';
      const how = m.method === 'facial' || m.method === 'face' ? 'por reconocimiento facial en el kiosco'
        : m.method === 'kiosk-manual' ? 'por selección manual en el kiosco' : m.method === 'manual' ? 'manualmente desde la suite'
        : m.method === 'kiosk-facial-offline' ? 'por reconocimiento facial en el kiosco, sin conexión (enviada después)'
        : m.method === 'kiosk-manual-offline' ? 'como marcación sin conexión (enviada después)' : 'en el kiosco';
      return out('Asistencia', m.method === 'manual' || m.method === 'kiosk-manual' || m.method === 'kiosk-manual-offline' ? 'Marcación manual' : 'Marcación',
        `Registró ${label} de ${empName(row.resource_id)} a las ${val(m.actualClock)} ${how}${m.shiftDateISO ? ` (turno del ${dmy(m.shiftDateISO)})` : ''}.`,
        m.motivo ? [`Motivo: ${m.motivo}`] : [], 'Kiosco');
    }
    case 'attendance.correction': {
      const c = m.cambios || [];
      return out('Asistencia', 'Corrección de marcación', `Corrigió las marcaciones de ${val(m.colaborador)} del ${dayName(m.fecha)}.`,
        c.map(x => `${MARK_FIELD_ES[x.marcacion] || x.marcacion}: ${x.antes || 'sin marcar'} → ${x.despues}`).concat(m.motivo ? [`Motivo: ${m.motivo}`] : []));
    }
    case 'attendance.evidence_settings': return out('Configuración', 'Evidencia de marcaciones',
      `Configuró la evidencia del kiosco: foto de evidencia ${m.foto ? 'activada' : 'desactivada'}, alerta de entorno diferente ${m.entorno ? 'activada' : 'desactivada'}.`);
    case 'attendance.device_env_reset': return out('Asistencia', 'Entorno del kiosco reiniciado',
      `Reinició el aprendizaje del entorno del kiosco ${val(m.deviceName)}: volverá a aprender cómo se ve su lugar.`);
    case 'attendance.alerts_auto_unjustified': return out('Asistencia', 'Novedades injustificadas automáticamente',
      `La suite marcó como injustificada(s) ${m.cantidad || 0} novedad(es) que nadie gestionó en ${m.horas || 24} horas. Se pueden cambiar a justificada en Asistencia → Alertas.`, [], 'Sistema (automático)');
    case 'attendance.env_learned': return out('Asistencia', 'Kiosco aprendió un fondo',
      `Confirmó que una marcación sospechosa del ${dayName(m.fecha)} era en el mismo lugar (otra luz): el kiosco aprendió ese fondo.`,
      [m.alertaJustificada ? 'La marcación sospechosa quedó justificada.' : null, m.otrasJustificadas ? `También se justificaron ${m.otrasJustificadas} marcación(es) sospechosa(s) parecida(s).` : null].filter(Boolean));
    case 'attendance.mark_voided': return out('Asistencia', m.reasignadaA ? 'Marcación reasignada' : 'Marcación anulada',
      m.reasignadaA
        ? `Pasó la marcación de ${val(m.marcacion)} de las ${val(m.hora)} del ${dayName(m.fecha)} de ${val(m.colaborador)} a ${val(m.reasignadaA)} (el kiosco la había registrado a la persona equivocada).`
        : `Anuló la marcación de ${val(m.marcacion)} de las ${val(m.hora)} del ${dayName(m.fecha)} de ${val(m.colaborador)}.`,
      [m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
    case 'attendance.absence_alert_removed': return out('Asistencia', '"No se presentó" eliminada',
      `La suite eliminó ${m.cantidad || 0} alerta(s) de "no se presentó" porque ese día quedó como descanso (o novedad) en el cuadro de turnos y la persona no tenía marcaciones.`, (m.detalle || []).slice(0, 10), 'Sistema (automático)');
    case 'discipline.generate': return out('Colaboradores', 'Llamado de atención generado', `Generó la comunicación de novedades (${val(m.tipo)}) de ${val(m.colaborador)}.`);
    case 'discipline.discard': return out('Colaboradores', 'Llamado de atención descartado', `Descartó el llamado propuesto (${val(m.tipo)}) de ${val(m.colaborador)}.`, [m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
    case 'discipline.annul': return out('Colaboradores', 'Llamado de atención anulado', `Anuló la comunicación (${val(m.tipo)}) ya enviada a ${val(m.colaborador)}.`, [m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
    case 'discipline.send': return out('Colaboradores', 'Llamado de atención enviado', `Creó el enlace de la comunicación (${val(m.tipo)}) de ${val(m.colaborador)} para enviarlo por WhatsApp (vence el ${dayName(m.vence)}).`);
    case 'discipline.received': return out('Colaboradores', 'Llamado de atención recibido', `El colaborador abrió la comunicación (${val(m.tipo)}) y confirmó que la recibió.`, [], 'Colaborador (enlace)');
    case 'discipline.signed': return out('Colaboradores', 'Llamado de atención firmado', `${val(m.colaborador)} firmó electrónicamente la comunicación (${val(m.tipo)}).`, [], 'Colaborador (enlace)');
    case 'discipline.descargos': return out('Colaboradores', 'Descargos recibidos', `El colaborador envió sus descargos a la comunicación (${val(m.tipo)}).`, [], 'Colaborador (enlace)');
    case 'discipline.config': return out('Configuración', 'Reglas de llamados de atención', 'Cambió las reglas o las plantillas de los llamados de atención.');
    case 'vacations.initial': {
      const d = (x) => x ? String(x).split('-').reverse().join('/') : '';
      const n = (x) => String(Math.round((Number(x) || 0) * 100) / 100).replace('.', ',');
      const desc = (s) => [`Periodos anteriores: ${n(s.anteriores)}`, s.desde ? `Causados del ${d(s.desde)} al ${d(s.hasta)}: ${n(s.causados)}` : null, s.disfrutados ? `Ya disfrutados (fuera de la suite): −${n(s.disfrutados)}` : null].filter(Boolean).join(' · ');
      return out('Colaboradores', m.antes ? 'Saldo inicial de vacaciones rehecho' : 'Saldo inicial de vacaciones',
        `${m.antes ? 'Rehízo' : 'Registró'} el saldo inicial de vacaciones de ${val(m.colaborador)}: ${n(m.total)} día(s) hábil(es).`,
        [desc(m), m.antes ? `Antes: ${n(m.antes.total)} día(s)${m.antes.anteriores != null ? ' (' + desc(m.antes) + ')' : ''}` : null, m.motivo ? `Nota: ${m.motivo}` : null].filter(Boolean));
    }
    case 'vacations.move': {
      const T = { ingreso: 'Fecha de ingreso (vacaciones)', inicial: 'Saldo inicial de vacaciones', ajuste: 'Ajuste de vacaciones', reinicio: 'Contrato nuevo: vacaciones reiniciadas' };
      const txt = m.tipo === 'ingreso' ? `Registró la fecha de ingreso de ${val(m.colaborador)}: ${dayName(m.fecha)}.`
        : m.tipo === 'reinicio' ? `Reinició el conteo de vacaciones de ${val(m.colaborador)} desde el ${dayName(m.fecha)} (contrato nuevo; las anteriores se liquidaron).`
        : `${m.tipo === 'inicial' ? 'Registró el saldo inicial' : 'Ajustó las vacaciones'} de ${val(m.colaborador)}: ${m.cantidad > 0 ? '+' : ''}${m.cantidad} día(s) hábil(es).`;
      return out('Colaboradores', T[m.tipo] || 'Vacaciones', txt, [m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
    }
    case 'rest_days.move': return out('Colaboradores', m.tipo === 'inicial' ? 'Saldo inicial de descansos' : 'Ajuste de descansos acumulados',
      `${m.tipo === 'inicial' ? 'Registró el saldo inicial' : 'Ajustó los descansos acumulados'} de ${val(m.colaborador)}: ${m.cantidad > 0 ? '+' : ''}${m.cantidad} descanso(s).`,
      [m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
    case 'attendance.half_day_decision': {
      const MODE = { extra: 'Pagar como horas extra (no cuenta como día laborado)', dia: 'Contar como día laborado (queda debiendo el tiempo)', pendiente: 'Por decidir' };
      const h = (x) => `${((Number(x) || 0) / 60).toFixed(2).replace('.', ',')} h`;
      return out('Asistencia', 'Salida antes de media jornada', `Decidió cómo tratar el día ${dayName(m.fecha)} de ${val(m.colaborador)}: ${MODE[m.decision] || m.decision}.`,
        [`Antes: ${MODE[m.antes] || m.antes || '-'}`, `Trabajó ${h(m.trabajadoMin)} de una jornada de ${h(m.jornadaMin)}`, `Como extra: diurna ${h(m.extraDiurnaMin)} · nocturna ${h(m.extraNocturnaMin)}`]);
    }
    case 'attendance.half_day_recalc': return out('Asistencia', 'Regla de media jornada aplicada',
      `La suite revisó los turnos ya cerrados del periodo aún sin liquidar: ${m.pagadosComoExtra || 0} día(s) de prestación de servicios quedaron pagados como horas extra y ${m.porDecidir || 0} día(s) de otros contratos quedaron "Por decidir".`, [], 'Sistema (automático)');
    case 'attendance.early_leave_tolerance_recalc': return out('Asistencia', 'Tolerancia de salida anticipada aplicada',
      `La suite recalculó ${m.dias || 0} día(s) del periodo aún sin liquidar con salida anticipada de menos de ${m.toleranciaMin || 5} minutos: ese tiempo ya no se descuenta de las horas extras (las alertas se conservan).`, [], 'Sistema (automático)');
    case 'attendance.false_late_fixed': return out('Asistencia', 'Llegadas tarde corregidas',
      `La suite corrigió ${m.cantidad || 0} llegada(s) tarde que en realidad fueron a tiempo (marcadas en el último minuto antes de la hora de entrada; los segundos se redondeaban al minuto siguiente).`, (m.marcaciones || []).slice(0, 10), 'Sistema (automático)');
    case 'attendance.alerts_auto_justified': return out('Asistencia', 'Salidas anticipadas justificadas automáticamente',
      `La suite marcó como justificada(s) ${m.cantidad || 0} salida(s) anticipada(s) que nadie gestionó en ${m.horas || 24} horas. Se pueden cambiar a injustificada en Asistencia → Alertas.`, [], 'Sistema (automático)');
    case 'attendance.alert_managed': {
      const TIPO = { llegada_tarde: 'llegada tarde', exceso_almuerzo: 'exceso de almuerzo', salida_anticipada: 'salida anticipada', inasistencia: 'no se presentó', turno_sin_cerrar: 'turno sin cerrar', marcacion_manual: 'marcación manual', etapa_extendida: 'etapa extendida' , entorno_diferente: 'entorno diferente (marcación sospechosa)' };
      return out('Asistencia', 'Gestión de novedad',
        `Marcó como ${String(m.estado || 'pendiente').toLowerCase()} la novedad "${TIPO[m.tipo] || m.tipo || 'novedad'}" de ${val(m.colaborador)} del ${dayName(m.fecha)}.`,
        [m.estadoAnterior && m.estadoAnterior !== m.estado ? `Estado: ${m.estadoAnterior} → ${m.estado}` : null,
          m.categoria ? `Categoría: ${m.categoria}` : null, m.nota ? `Nota: ${m.nota}` : null, m.soporte ? `Soporte adjunto: ${m.soporte}` : null].filter(Boolean));
    }
    case 'attendance.digest_settings': return out('Asistencia', 'Resumen diario por correo',
      m.activo ? `${m.activoAntes ? 'Actualizó' : 'Activó'} el resumen diario de asistencia por correo, a las ${String(m.hora).padStart(2, '0')}:00.` : 'Desactivó el resumen diario de asistencia por correo.',
      [m.destinatarios ? `Destinatarios: ${m.destinatarios}` : null, m.adicionales ? `Correos adicionales: ${m.adicionales}` : null].filter(Boolean));
    case 'attendance.device_alert_settings': return out('Asistencia', 'Salud de los kioscos',
      `Cambió a ${m.minutos} min el tiempo sin señal para considerar un kiosco "sin conexión".`);
    case 'attendance.offline_resolved': return out('Asistencia', 'Marcación sin conexión',
      m.accion === 'aplicada' ? `Asignó a ${val(m.colaborador)} una marcación guardada sin conexión del ${String(m.hora || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1')}.` : `Descartó una marcación guardada sin conexión del ${String(m.hora || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1')}.`,
      m.motivo ? [`Motivo: ${m.motivo}`] : []);
    case 'shifts.purged': return out('Planilla', 'Depuración de turnos', `Se eliminaron automáticamente ${m.turnos || 0} turno(s) programados antes del ${dmy(m.antesDe)} (plazo de conservación configurado).`, [], 'Sistema');
    case 'settings.shift_retention': return out('Configuración', 'Conservación de turnos',
      m.despues ? `Configuró la depuración automática de turnos con más de ${m.despues} años.` : 'Desactivó la depuración automática de turnos.', m.antes ? [`Antes: ${m.antes} años`] : []);
    case 'attendance.face_enroll': return out('Asistencia', 'Perfil facial', `Registró el perfil facial de ${val(m.employeeName)} para marcar en el kiosco.`);
    case 'attendance.face_deactivate': return out('Asistencia', 'Perfil facial', `Desactivó el perfil facial de ${val(m.employeeName)}.`);
    case 'attendance.device_create': return out('Asistencia', 'Dispositivo de marcación', `Creó el dispositivo de marcación "${val(m.deviceName)}".`);
    case 'attendance.device_rotate': return out('Asistencia', 'Dispositivo de marcación', `Generó un nuevo token para el dispositivo "${val(m.deviceName)}" (el anterior dejó de funcionar).`);
    case 'attendance.device_deactivate': return out('Asistencia', 'Dispositivo de marcación', `Desactivó el dispositivo de marcación "${val(m.deviceName)}".`);
    case 'attendance.device_delete': return out('Asistencia', 'Dispositivo de marcación', `Eliminó el dispositivo de marcación "${val(m.deviceName)}" (estaba desactivado). Sus marcaciones y fotos se conservan.`);
    case 'attendance.device_assign': return out('Asistencia', 'Dispositivo de marcación', `Asignó ${m.count || 0} colaborador(es) al dispositivo${m.deviceName ? ` "${m.deviceName}"` : ''}.`);

    // ---------------- Liquidación ----------------
    case 'payroll.period_closed': return out('Liquidación', 'Cierre de periodo',
      `Cerró el periodo de ${m.tipo === 'recargos' ? 'recargos' : 'horas extras'} del ${String(m.periodo || '').replace(/(\d{4}-\d{2}-\d{2})/g, (x) => dmy(x))}.`,
      [`${m.colaboradores || 0} colaborador(es) · total ${money(m.total)}`].concat(m.diasPendientes ? [`${m.diasPendientes} día(s) pendiente(s) quedaron sin incluir`] : []));
    case 'payroll.period_reopened': return out('Liquidación', 'Reapertura de periodo',
      `Reabrió el periodo de ${m.tipo === 'recargos' ? 'recargos' : 'horas extras'} del ${String(m.periodo || '').replace(/(\d{4}-\d{2}-\d{2})/g, (x) => dmy(x))}.`, m.motivo ? [`Motivo: ${m.motivo}`] : []);
    case 'payroll.day_zero_set': return out('Liquidación', 'Día 0', m.diaCero ? `Definió el Día 0 de la organización en ${dmy(m.diaCero)}.` : 'Quitó el Día 0 de la organización.');
    case 'payroll.opening_balance_set': return out('Liquidación', 'Saldo inicial',
      `Registró el saldo inicial de ${val(m.colaborador)} al ${dmy(m.corte)}.`,
      [m.extraDiurna ? `Extra diurna: ${hm(m.extraDiurna)}` : null, m.extraNocturna ? `Extra nocturna: ${hm(m.extraNocturna)}` : null,
        m.recargoNocturno ? `Recargo nocturno: ${hm(m.recargoNocturno)}` : null, m.dominical ? `Dominical/festivo: ${hm(m.dominical)}` : null, m.nota ? `Nota: ${m.nota}` : null].filter(Boolean));
    case 'payroll.opening_balance_deleted': return out('Liquidación', 'Saldo inicial', `Eliminó el saldo inicial de ${empName(row.resource_id)}.`, m.motivo ? [`Motivo: ${m.motivo}`] : []);
    case 'payroll.adjustment': return out('Liquidación', 'Ajuste manual (anterior)', `Ajustó manualmente la liquidación de ${val(m.colaborador)} (${val(m.periodo)}).`,
      [m.campo ? `${m.campo}: ${m.campo === 'total' ? money(m.antes) : val(m.antes)} → ${m.campo === 'total' ? money(m.despues) : val(m.despues)}` : null, m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
    case 'payroll.adjustments_reset': return out('Liquidación', 'Ajuste manual (anterior)', `Quitó ${m.ajustesEliminados || 0} ajuste(s) manual(es) del periodo ${val(m.periodo)}.`, m.motivo ? [`Motivo: ${m.motivo}`] : []);

    // ---------------- Configuración ----------------
    case 'settings.update': {
      const c = m.cambios || [];
      if (!c.length) return out('Configuración', 'Ajustes de la organización', `Actualizó los ajustes de la organización${m.orgName ? ` (${m.orgName})` : ''}.`);
      return out('Configuración', 'Ajustes de la organización', `Cambió ${c.map(x => x.campo.toLowerCase()).join(', ')}.`,
        c.map(x => `${x.campo}: ${x.campo === 'Salario mínimo' ? money(x.antes) : val(x.antes)} → ${x.campo === 'Salario mínimo' ? money(x.despues) : val(x.despues)}`));
    }
    case 'departments.replace': {
      const d = [];
      (m.agregadas || []).forEach(x => d.push(`Agregó el área: ${x}`));
      (m.renombradas || []).forEach(x => d.push(`Renombró: ${x.antes} → ${x.despues}`));
      (m.eliminadas || []).forEach(x => d.push(`Eliminó el área: ${x}`));
      if (m.ordenCambiado) d.push('Cambió el orden de las áreas');
      return out('Configuración', 'Áreas', d.length ? `Modificó las áreas de la organización (${d.length} cambio(s)).` : `Actualizó las áreas (${m.count || 0}).`, d);
    }
    case 'org_data.seed_demo': return out('Configuración', 'Datos de ejemplo', 'Restauró los datos de ejemplo (reemplazó colaboradores, turnos y áreas).');
    case 'org_data.ignored': return out('Configuración', 'Cambios no permitidos', 'Intentó guardar cambios que su rol no permite; no se aplicaron.', m.ignorados || []);
    case 'org_data.sync': return out('Configuración', 'Guardado (registro anterior)', 'Guardó cambios en colaboradores y turnos (registro anterior, sin detalle).');

    case 'attendance.indicator_goals': {
      const N = { ausentismoMax: 'Ausentismo máximo (%)', puntualidadMin: 'Puntualidad mínima (%)', perdidoMaxPorTurno: 'Tiempo perdido máx. por turno (min)', extrasValorMaxMes: 'Valor de horas extra máx. por mes ($)', costoMaxMes: 'Costo de extras y recargos máx. por mes ($)', sinCerrarMaxPct: 'Turnos sin cerrar máx. (%)', manualesMaxPct: 'Marcaciones manuales máx. (%)', correccionesMaxPct: 'Correcciones en el historial máx. (%)' };
      const a = m.antes || {}, b = m.despues || {};
      const fv = (k, v) => v == null ? 'sin meta' : (/\(\$\)$/.test(N[k]) ? money(v) : v);
      const d = Object.keys(N).filter(k => String(a[k] ?? '') !== String(b[k] ?? '')).map(k => `${N[k]}: ${fv(k, a[k])} → ${fv(k, b[k])}`);
      return out('Configuración', 'Metas de indicadores', d.length ? `Cambió las metas de los indicadores (${d.length}).` : 'Guardó las metas de los indicadores sin cambios.', d);
    }
    // ---------------- Super Admin ----------------
    case 'organization.create': case 'organization.update': case 'organization.delete':
    case 'organization.activate': case 'organization.deactivate': {
      // ctx.orgs (solo en el panel Super Admin) permite mostrar el nombre actual.
      const orgName = m.name || (ctx.orgs && ctx.orgs.get(row.resource_id)) || 'la organización';
      const T = {
        'organization.create': ['Organización creada', `Creó la organización ${orgName}${m.nit ? ` (NIT ${m.nit})` : ''}.`],
        'organization.update': ['Organización modificada', `Modificó los datos de la organización ${orgName}.`],
        'organization.delete': ['Organización eliminada', `Eliminó la organización ${orgName} y todos sus datos.`],
        'organization.activate': ['Organización activada', `Activó la organización ${orgName}; sus usuarios pueden volver a ingresar.`],
        'organization.deactivate': ['Organización desactivada', `Desactivó la organización ${orgName}; sus usuarios ya no pueden ingresar.`],
      }[row.action];
      return out('Configuración', T[0], T[1], [], 'Super Admin');
    }
    default:
      return out('Otros', 'Acción del sistema', `Acción registrada: ${row.action}.`);
  }
}

module.exports = { describeAudit };
