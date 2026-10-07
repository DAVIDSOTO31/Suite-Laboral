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
function money(v) { return '$' + Math.round(Number(v) || 0).toLocaleString('es-CO'); }
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
    case 'auth.logout': return out('Sesión', 'Cierre de sesión', 'Cerró sesión.');
    case 'auth.login_failed': return out('Sesión', 'Intento fallido', `Intento de inicio de sesión fallido con el correo ${val(m.email)}.`, [], m.email || 'Desconocido');
    case 'auth.invite_accepted': return out('Sesión', 'Invitación aceptada', 'Aceptó la invitación y creó su contraseña.');
    case 'auth.password_reset_requested': return out('Sesión', 'Recuperar contraseña', 'Solicitó un enlace para recuperar su contraseña.', [], m.email);
    case 'auth.password_reset_completed': return out('Sesión', 'Contraseña cambiada', 'Cambió su contraseña con el enlace de recuperación.');

    // ---------------- Usuarios ----------------
    case 'user.invite': return out('Usuarios', 'Invitación de usuario',
      `Invitó a ${val(m.email)} a la suite como ${ROLE_ES[m.role] || m.role || 'usuario'}${m.employee ? `, vinculado al colaborador ${m.employee}` : ''}.`);
    case 'user.update': {
      const who = m.usuario || userEmail(row.resource_id);
      const parts = [];
      if (m.rolNuevo || m.role) parts.push(`cambió su rol a ${ROLE_ES[m.rolNuevo || m.role] || m.rolNuevo || m.role}`);
      if (Object.prototype.hasOwnProperty.call(m, 'colaboradorVinculado')) parts.push(m.colaboradorVinculado ? `lo vinculó con el colaborador ${m.colaboradorVinculado}` : 'lo desvinculó de su ficha de colaborador');
      else if (Object.prototype.hasOwnProperty.call(m, 'employeeId')) parts.push(m.employeeId ? `lo vinculó con el colaborador ${empName(m.employeeId)}` : 'lo desvinculó de su ficha de colaborador');
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
      [m.documento ? `Documento: ${m.documento}` : null, m.correo ? `Correo: ${m.correo}` : null, m.salario ? `Salario: ${money(m.salario)}` : null].filter(Boolean));
    case 'employee.updated': {
      const c = m.cambios || [];
      return out('Colaboradores', 'Ficha modificada', `Modificó la ficha de ${val(m.colaborador)}: ${c.map(x => x.campo.toLowerCase()).join(', ')}.`,
        c.map(x => `${x.campo}: ${x.campo === 'Salario' ? money(x.antes) : val(x.antes)} → ${x.campo === 'Salario' ? money(x.despues) : val(x.despues)}`));
    }
    case 'employee.deleted': return out('Colaboradores', 'Colaborador eliminado', `Eliminó la ficha del colaborador ${val(m.colaborador)}.`);
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
    case 'attendance.alert_managed': {
      const TIPO = { llegada_tarde: 'llegada tarde', exceso_almuerzo: 'exceso de almuerzo', salida_anticipada: 'salida anticipada', inasistencia: 'no se presentó', turno_sin_cerrar: 'turno sin cerrar', marcacion_manual: 'marcación manual' };
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
    case 'attendance.face_enroll': return out('Asistencia', 'Perfil facial', `Registró el perfil facial de ${val(m.employeeName)} para marcar en el kiosco.`);
    case 'attendance.face_deactivate': return out('Asistencia', 'Perfil facial', `Desactivó el perfil facial de ${val(m.employeeName)}.`);
    case 'attendance.device_create': return out('Asistencia', 'Dispositivo de marcación', `Creó el dispositivo de marcación "${val(m.deviceName)}".`);
    case 'attendance.device_rotate': return out('Asistencia', 'Dispositivo de marcación', `Generó un nuevo token para el dispositivo "${val(m.deviceName)}" (el anterior dejó de funcionar).`);
    case 'attendance.device_deactivate': return out('Asistencia', 'Dispositivo de marcación', `Desactivó el dispositivo de marcación "${val(m.deviceName)}".`);
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
      [m.campo ? `${m.campo}: ${val(m.antes)} → ${val(m.despues)}` : null, m.motivo ? `Motivo: ${m.motivo}` : null].filter(Boolean));
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

    // ---------------- Super Admin ----------------
    case 'organization.create': case 'organization.update': case 'organization.delete':
      return out('Configuración', 'Organización', 'El administrador de la plataforma modificó los datos de la organización.', [], 'Super Admin');
    default:
      return out('Otros', 'Acción del sistema', `Acción registrada: ${row.action}.`);
  }
}

module.exports = { describeAudit };
