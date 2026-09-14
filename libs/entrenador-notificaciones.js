const { gmailComoEntrenador } = require('./google-oauth-entrenador.js');
const { verificarEntrenador } = require('./sesion-cliente.js');

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
  exigirEntrenador,
  exigirEntrenadorOCron,
};
