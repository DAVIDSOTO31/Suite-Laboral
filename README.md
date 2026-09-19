# RR.HH PYMES — Plataforma Multi-Organización (Multi-Tenant)

Este proyecto convierte tu aplicación original (`RRHH_PYMES_Control_Horarios_nuevo_.html`,
un archivo HTML de un solo tenant que vivía solo en el navegador) en una
plataforma real multi-organización con autenticación, roles y una cuenta
Super Admin, **sin rehacerla desde cero**: el diseño visual, los cálculos de
nómina/turnos y casi toda la interfaz original se conservan.

---

## A. Diagnóstico del proyecto original

| Aspecto | Estado original |
|---|---|
| Frontend | HTML único (~3950 líneas) + Tailwind (CDN) + Chart.js (CDN) + FontAwesome (CDN) + JS vanilla |
| Backend | **No existía** |
| Base de datos | **No existía** |
| Persistencia | `localStorage` del navegador, solo para: nombre de empresa, logo, orden de departamentos y plantillas de turnos |
| Colaboradores / turnos | Vivían solo en memoria (`appState`); se **regeneraban desde datos de ejemplo** en cada recarga (`seedDemoData()` en `window.onload`) |
| Autenticación / roles | No existían |
| Multi-tenant | No existía (una sola instancia = una sola empresa) |

**Conclusión que guió el diseño:** ningún control de acceso implementado solo
en el navegador es seguro (cualquier persona puede editar el JavaScript de su
propia pestaña). Por eso se construyó un backend real. Como este entorno de
desarrollo no tenía acceso de red saliente (no se pudo ejecutar `npm install`),
el backend se implementó **sin dependencias externas**, usando únicamente
módulos integrados de Node.js 22: `node:http`, `node:sqlite`, `node:crypto`.
Esto tiene una ventaja práctica adicional: se instala y ejecuta con
`npm start`, sin pasos adicionales.

---

## B. Arquitectura implementada

```
Navegador (login.html / app.html / superadmin.html, JS vanilla + fetch)
        │  cookies HttpOnly + CSRF de doble envío
        ▼
Servidor Node.js (src/server.js) — enrutador propio, sin Express
        │
        ├── middleware/auth.js     → sesión, permisos, aislamiento por organización
        ├── routes/auth.routes.js  → login, logout, recuperación, invitaciones
        ├── routes/superadmin.routes.js → CRUD global (organizaciones, usuarios, auditoría)
        ├── routes/org.routes.js   → datos de la app (colaboradores, turnos, deptos, ajustes) + usuarios de LA org
        └── db.js                  → esquema SQLite, migraciones idempotentes, semillas
                ▼
        SQLite (data/app.db) — un solo archivo, con organization_id en cada tabla de dominio
```

- **Autenticación**: contraseñas con `scrypt` (nunca texto plano), sesiones
  firmadas con HMAC-SHA256 en cookie `HttpOnly` + `SameSite=Strict`, CSRF de
  doble envío (cookie `csrf` no-HttpOnly + header `X-CSRF-Token`), rate
  limiting de intentos de login (5 fallos / 15 min por correo+IP).
- **RBAC**: catálogo de permisos por módulo (`users.*`, `employees.*`,
  `shifts.*`, `reports.view`, `settings.manage`, `audit.view`). Roles por
  organización: `org_admin` (todos los permisos de su org), `supervisor`
  (ver/crear/editar, sin borrar ni administrar usuarios), `empleado`
  (solo lectura). Rol global `super_admin` con todos los permisos, sin
  organización asociada. La autorización se valida **siempre en el backend**
  (`middleware/auth.js`), nunca solo ocultando botones.
- **Aislamiento de datos**: toda tabla de dominio (`employees`, `shifts`,
  `departments`, `shift_presets`, `org_settings`, `users`) tiene
  `organization_id`. Cada consulta lo filtra. Un intento de acceso cruzado
  (ej. `POST /api/org/users/<id-de-otra-org>/toggle-status`) responde `404`
  (no `403`) para no confirmar siquiera que el recurso existe.
- **Auditoría**: tabla `audit_logs` con organización, usuario, acción,
  recurso, IP y fecha. Consultable por Super Admin (global) y por
  administradores de organización (solo la suya).
- **Invitaciones**: un admin nunca conoce ni fija la contraseña de otro
  usuario. Se genera un token de un solo uso con expiración (72h) que el
  usuario usa para fijar su propia contraseña en `accept-invite.html`.

---

## C. Modelo de datos (SQLite)

Tablas nuevas: `organizations`, `permissions`, `roles`, `role_permissions`,
`users`, `user_roles`, `invitations`, `password_resets`, `login_attempts`,
`audit_logs`.

Tablas de dominio (ya existían como arrays en memoria; ahora son tablas con
`organization_id`): `departments`, `shift_presets`, `employees`, `shifts`,
`org_settings`.

`user_roles` es una tabla puente pensada para que, en el futuro, un usuario
pueda pertenecer a más de una organización sin cambiar el esquema (hoy el
producto solo asigna una organización por usuario vía `users.organization_id`,
tal como pediste para simplificar la primera versión).

---

## D. Archivos modificados/creados

- **Nuevo backend completo**: `src/**` (servidor, rutas, middleware, DB).
- **`public/app.html`**: es tu archivo original, con estos cambios puntuales:
  - Se agregó una barra de usuario (correo + botón de salir) en el header.
  - Se agregó un módulo nuevo "Usuarios & Seguridad" en el sidebar (oculto si
    no tienes permiso) para invitar/activar/desactivar usuarios de tu propia
    organización y ver su auditoría.
  - `loadDepartments()`, `saveDepartmentsToStorage()`, `loadShiftPresets()`,
    `saveShiftPresets()`, `updateOrgName()`, `handleLogoUpload()` ahora leen y
    escriben contra la API en vez de `localStorage`.
  - Colaboradores y turnos (que antes NO se guardaban en ningún lado) ahora sí
    persisten: `renderEmployeesView()`, `renderWeeklyRoster()` y
    `renderMasterShiftsTable()` disparan una sincronización automática
    (debounced) hacia `POST /api/org/sync`.
  - `window.onload` ya no llama a `seedDemoData()` automáticamente; en su
    lugar valida la sesión y carga los datos reales de tu organización
    (`appBootstrap()`). El botón "Restaurar Datos y Orden de Áreas" sigue
    existiendo, pero ahora pide confirmación si ya hay datos cargados.
  - Todo el resto (cálculos de nómina, calculador de turnos, exportar CSV,
    auditoría legal CST, informes) se dejó intacto.
- **Nuevos**: `public/login.html`, `public/superadmin.html`,
  `public/accept-invite.html`, `public/reset-password.html`,
  `public/forgot-password.html`, `public/index.html`.

---

## E. Riesgos y decisiones que debes conocer

1. **Sin proveedor de email real.** `src/lib/mailer.js` imprime los enlaces de
   invitación/recuperación en la consola del servidor (`EMAIL_MODE=console`)
   porque este entorno no tenía acceso de red para integrar un proveedor real.
   Para producción, reemplaza ese archivo con una integración real (SendGrid,
   SES, Postmark, Resend, etc.) — el resto del sistema no cambia.
2. **Persistencia de colaboradores/turnos por sincronización completa
   (full-state), no CRUD granular por registro.** La app original nunca
   persistía esto (se perdía al recargar). Para esta primera versión se
   implementó un endpoint `POST /api/org/sync` que reemplaza la lista completa
   de colaboradores/turnos de la organización, debounced 900ms tras cada
   edición. Es simple y ya está completamente aislado por organización, pero
   no genera un registro de auditoría por cada campo cambiado (sí registra un
   evento `org_data.sync` con conteos). Si más adelante necesitas edición
   concurrente entre varios usuarios a la vez o auditoría campo por campo,
   estos son los siguientes endpoints a construir: `POST/PUT/DELETE
   /api/org/employees/:id` y lo mismo para `/api/org/shifts/:id`.
3. **`node:sqlite` es una API experimental de Node.js 22** (funciona bien en
   pruebas, pero Node imprime una advertencia `ExperimentalWarning` al
   arrancar). Si prefieres una base de datos más "tradicional" en producción,
   el código de acceso a datos está concentrado en `src/db.js` y en cada
   `routes/*.js` — migrar a PostgreSQL más adelante no requeriría tocar la
   lógica de negocio, solo la capa de acceso a datos.
4. **CORS** está cerrado por defecto (incluso mismo-origen no necesita CORS
   porque el frontend se sirve desde el mismo servidor). Si vas a separar
   frontend y backend en dominios distintos, configura `ALLOWED_ORIGIN` en
   `.env`.
5. **No se implementó verificación de correo electrónico** (punto 5 del
   brief la mencionaba como condicional "si es necesario"): el correo se
   confirma implícitamente al aceptar la invitación o restablecer la
   contraseña mediante el token enviado a ese correo.

---

## F. Plan de migración (sin perder información)

Como el proyecto original no tenía backend ni base de datos, no hay datos que
migrar automáticamente. El primer arranque:

1. Crea `data/app.db` y todas las tablas (`CREATE TABLE IF NOT EXISTS`, por lo
   que **re-ejecutar el servidor nunca borra datos existentes**).
2. Crea la cuenta Super Admin con el correo/clave de tu `.env` (o los valores
   por defecto — cámbialos).
3. Cada organización que crees empieza vacía; usa "Restaurar Datos y Orden de
   Áreas" dentro de `app.html` (o `POST /api/org/seed-demo`) si quieres cargar
   el set de datos de ejemplo del proyecto original.

---

## Cómo ejecutarlo

Requiere **Node.js 22.5 o superior** (usa `node:sqlite`, que es nativo de
Node 22+). No requiere `npm install` — cero dependencias externas.

```bash
cd rrhh-multitenant
cp .env.example .env      # edita SESSION_SECRET, credenciales del Super Admin, etc.
npm start                 # o: node src/server.js
```

Abre `http://localhost:3000`. En el primer arranque, la consola imprime las
credenciales del Super Admin (tomadas de `.env`, o los valores de ejemplo si
no configuraste nada — **cámbialas**).

### Flujo típico

1. Inicia sesión como Super Admin → pestaña **Organizaciones** → crear una.
2. Pestaña **Usuarios** → invitar un usuario, asignarle la organización y el
   rol `org_admin`.
3. La invitación (enlace con token) se imprime en la consola del servidor
   (ver nota sobre email arriba). Ábrela en el navegador para fijar la
   contraseña.
4. Inicia sesión con esa cuenta → llegas a `app.html`, la aplicación original,
   ahora con datos propios de tu organización.

### Ejecutar las pruebas automatizadas

```bash
node --test tests/integration.test.js
```

Cubre (ver `tests/integration.test.js` para el detalle completo, sección 18
del encargo original):

- Login válido/inválido y rate limiting.
- Rutas protegidas rechazan a usuarios no autenticados (401) y sin CSRF (403).
- Aislamiento horizontal: Organización A nunca ve datos de Organización B.
- IDOR: un admin de una organización no puede tocar usuarios de otra
  (404, no 403 — no revela existencia).
- Permisos: un rol sin el permiso requerido es rechazado aunque llame la API
  directamente (403), incluso si la interfaz nunca le mostró el botón.
- Invitaciones de un solo uso, recuperación de contraseña de un solo uso.
- Organizaciones desactivadas bloquean el login inmediatamente.
- Super Admin puede administrar organizaciones y usuarios globalmente.
- Los logs de auditoría se generan y respetan el límite por organización.

---

## Variables de entorno (`.env`)

Ver `.env.example` para la lista completa y comentada. Las más importantes
para producción:

- `SESSION_SECRET`: genera uno aleatorio de 48 bytes y no lo compartas.
- `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`: solo se usan la primera vez que
  se crea la base de datos.
- `EMAIL_MODE`: cámbialo cuando integres un proveedor real en
  `src/lib/mailer.js`.

---

## Qué NO se hizo (y por qué), para que no haya sorpresas

- No se instaló ningún paquete npm (Express, bcrypt, jsonwebtoken, etc.)
  porque este entorno de desarrollo no tenía acceso de red saliente. El
  reemplazo funcional de cada uno está documentado arriba y es igual de
  seguro (scrypt en vez de bcrypt, HMAC firmado en vez de JWT de una
  librería, enrutador propio en vez de Express) pero si prefieres esas
  librerías específicas, migrar es sencillo porque la lógica de negocio está
  separada de esos detalles.
- No se envían correos reales (ver punto E.1).
- La persistencia de colaboradores/turnos es full-state-sync, no CRUD
  granular por registro (ver punto E.2) — funcionalmente completa y aislada,
  pero es el área con más espacio de mejora si el proyecto crece.
