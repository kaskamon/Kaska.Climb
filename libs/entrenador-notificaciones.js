const { gmailComoEntrenador } = require('./google-oauth-entrenador.js');
const { verificarEntrenador } = require('./sesion-cliente.js');
const { sanearFormula } = require('./sheets-sanitize.js');

// Correo donde llega el aviso de "cliente nuevo", los fallos de tareas
// programadas, etc. — el mismo entrenador, mandado desde su propia cuenta
// (ver libs/google-oauth-entrenador.js).
const CORREO_ENTRENADOR = 'kaskamon@gmail.com';

// Mismo mecanismo de construcción y envío para cualquier correo del
// entrenador a sí mismo o a un cliente — siempre desde su propia cuenta.
// "destinatario" puede venir, en última instancia, de un campo que rellena
// un desconocido en el formulario público de alta (api/listar-clientes.js,
// manejarAlta) — se le quita cualquier salto de línea antes de meterlo en
// la cabecera "To:", para que no se puedan colar cabeceras extra (p.ej. un
// Bcc:) escribiendo un correo con \r\n dentro.
async function enviarCorreoComoEntrenador(destinatario, asunto, cuerpo) {
  const gmail = gmailComoEntrenador();
  const destinatarioSeguro = String(destinatario).replace(/[\r\n]+/g, ' ').trim();
  const mensajeCrudo = [
    `To: ${destinatarioSeguro}`,
    `Subject: =?UTF-8?B?${Buffer.from(asunto, 'utf8').toString('base64')}?=`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    cuerpo,
  ].join('\r\n');
  const raw = Buffer.from(mensajeCrudo, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// Aviso por correo cuando una tarea programada (cron) falla del todo — sin
// esto, un fallo se queda solo en los logs de Vercel, que nadie mira a
// diario, y el entrenador nunca se entera de que algo dejó de funcionar.
// Best-effort: si hasta el propio aviso falla, no hay más que hacer aquí.
async function avisarFalloTareaProgramada(nombreTarea, mensajeError) {
  try {
    await enviarCorreoComoEntrenador(
      CORREO_ENTRENADOR,
      `Fallo en tarea programada: ${nombreTarea}`,
      `La tarea "${nombreTarea}" no se ha podido completar hoy:\r\n\r\n${mensajeError}`
    );
  } catch (e) { /* nada más que hacer si hasta el aviso falla */ }
}

// Deja constancia del resultado de la última ejecución de una tarea
// programada (backup diario, revisión de caducados) en la pestaña
// "Estado_Sistema" del Sheet de Clientes (hay que crearla a mano, igual que
// otras pestañas de la app — columnas: A tarea, B ok (Sí/No), C mensaje,
// D fecha). A diferencia del aviso por correo, esto solo depende de la
// cuenta de servicio (la misma que ya usa toda la app para leer/escribir
// Sheets) — nunca del token OAuth del propio entrenador, que es justo lo que
// puede romperse en silencio con el tiempo. Así, aunque el correo de aviso
// falle porque el OAuth está roto, esto se sigue escribiendo, y Clientes.html
// puede mostrarlo como un aviso visible la próxima vez que se abra la app.
// Nunca lanza — si la pestaña ni siquiera existe todavía, no debe romper la
// tarea programada en sí, que ya tiene su propio manejo de errores.
async function registrarEstadoTarea(sheets, spreadsheetId, tarea, ok, mensaje) {
  const SHEET_ESTADO = 'Estado_Sistema';
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${SHEET_ESTADO}'!A:A` });
    const filas = resp.data.values || [];
    const idx = filas.findIndex(f => (f[0] || '').trim() === tarea);
    const filaDestino = idx !== -1 ? idx + 1 : filas.length + 1;
    const fecha = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${SHEET_ESTADO}'!A${filaDestino}:D${filaDestino}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[tarea, ok ? 'Sí' : 'No', sanearFormula((mensaje || '').toString().slice(0, 500)), fecha]] },
    });
  } catch (e) {
    console.error(`No se pudo registrar el estado de la tarea "${tarea}": ${e.message}`);
  }
}

// Exige la contraseña del entrenador para acciones que se visitan
// directamente en el navegador (no llamadas AJAX desde una página ya
// protegida por middleware.js) — se protegen a sí mismas con el mismo popup
// nativo (WWW-Authenticate) que usa el resto del área de entrenador.
function exigirEntrenador(req, res) {
  if (verificarEntrenador(req).ok) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kaska.Climb"' });
  res.end('Acceso restringido — zona de entrenador.');
  return false;
}

// Igual que exigirEntrenador, pero acepta también el CRON_SECRET que Vercel
// manda solo en sus propias llamadas programadas (ver vercel.json) — para
// las acciones que se disparan solas cada día además de a mano.
function exigirEntrenadorOCron(req, res) {
  const cabecera = req.headers && req.headers.authorization;
  const esCron = !!process.env.CRON_SECRET && cabecera === `Bearer ${process.env.CRON_SECRET}`;
  if (esCron) return true;
  return exigirEntrenador(req, res);
}

module.exports = {
  CORREO_ENTRENADOR,
  enviarCorreoComoEntrenador,
  avisarFalloTareaProgramada,
  registrarEstadoTarea,
  exigirEntrenador,
  exigirEntrenadorOCron,
};
