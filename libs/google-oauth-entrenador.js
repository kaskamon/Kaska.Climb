const { google } = require('googleapis');

// Acceso a Drive y Gmail como el propio entrenador (no como la cuenta de
// servicio) — hace falta para que las cosas que se crean (carpetas de
// clientes, más adelante sesiones guardadas desde la tablet) nazcan ya siendo
// suyas, y para poder mandar el aviso de alta nueva desde su propia cuenta.
// Una cuenta de servicio no puede transferir la propiedad de un archivo a una
// cuenta de Gmail normal por API (Google lo bloquea desde 2022, siempre pide
// consentimiento manual), y tampoco puede mandar correos como si fuera él —
// por eso hace falta este segundo camino, aparte del de la cuenta de servicio
// que ya usan las hojas de cálculo.
//
// Mismo Client ID que login.html (Google Sign-In de clientes) — es del tipo
// "Aplicación web", así que también tiene un Client Secret en Google Cloud
// Console, solo hace falta usarlo aquí. El flujo de un solo uso para
// conseguir el refresh token vive dentro de api/listar-clientes.js
// (?accion=drive-oauth-inicio / ?accion=drive-oauth-callback) — en vez de en
// archivos propios, para no pasarnos del límite de funciones serverless del
// plan gratuito de Vercel (12 por despliegue).
const GOOGLE_CLIENT_ID = '750960934789-afud0r9hmq7fe700okgu0o0cer0cih1q.apps.googleusercontent.com';
const REDIRECT_URI = 'https://kaska-climb.vercel.app/api/listar-clientes?accion=drive-oauth-callback';

// Alcances que se piden en el consentimiento (ver ?accion=drive-oauth-inicio
// en api/listar-clientes.js) — si se añade uno nuevo aquí, hay que repetir el
// consentimiento una vez (el refresh token existente no cubre alcances que no
// pidió en su momento).
//
// drive.file (no "drive" a secas) a propósito: "drive" completo es un alcance
// "restringido" para Google — verificarlo puede exigir una auditoría de
// seguridad de pago. drive.file es "no sensible" (cero verificación) y solo
// da acceso a archivos que la propia app crea, o que el entrenador elige a
// mano con el selector nativo de Drive (ver conectar-drive.html) — por eso la
// carpeta padre de clientes y los dos Sheets ya existentes (no creados por la
// app) necesitan conectarse una vez ahí antes de que backup-diario o
// crearCarpetaCliente puedan escribir dentro.
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.send'];

function clienteOAuth() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

// Cliente OAuth ya autenticado como el entrenador, listo para pasarle a
// cualquier servicio de Google (Drive, Gmail...). Lanza si todavía no se ha
// completado el alta (?accion=drive-oauth-inicio) o falta el Client Secret.
function authComoEntrenador() {
  if (!process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_TRAINER_REFRESH_TOKEN) {
    throw new Error(
      'Todavía no está conectada tu cuenta de Google — visita /api/listar-clientes?accion=drive-oauth-inicio (dentro del área de entrenador) para completarlo.'
    );
  }
  const oauth2Client = clienteOAuth();
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_TRAINER_REFRESH_TOKEN });
  return oauth2Client;
}

function driveComoEntrenador() {
  return google.drive({ version: 'v3', auth: authComoEntrenador() });
}

function gmailComoEntrenador() {
  return google.gmail({ version: 'v1', auth: authComoEntrenador() });
}

// Access token corto (no el refresh token) para usar en el navegador del
// entrenador — lo necesita conectar-drive.html para abrir el selector nativo
// de Google Drive (Picker), que corre en el cliente y no puede usar el
// refresh token directamente. Nunca se guarda, solo vive en memoria de esa
// pestaña mientras dura la sesión de selección.
async function obtenerAccessTokenEntrenador() {
  const { token } = await authComoEntrenador().getAccessToken();
  return token;
}

module.exports = { GOOGLE_CLIENT_ID, REDIRECT_URI, SCOPES, clienteOAuth, driveComoEntrenador, gmailComoEntrenador, obtenerAccessTokenEntrenador };
