const { verificarAccesoCliente, verificarEntrenador } = require('../libs/sesion-cliente.js');
const { lunesDe } = require('../libs/planificacion-semanas.js');
const { authSheets, SCOPE_SOLO_LECTURA } = require('../libs/sheets-auth.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const COL_CORREO = 34; // AI — mismo campo que escribe api/enviar-sesion.js

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d).getTime();
}

// La marcaTemporal (columna A) la escribe api/enviar-sesion.js con
// `new Date().toLocaleString('es-ES', {timeZone:'Europe/Madrid'})`, formato
// "d/m/aaaa, HH:MM:SS" sin ceros a la izquierda — distinto del de la fecha de
// sesión (columna C, siempre dd/mm/aaaa), así que necesita su propio parser.
// Tolerante con la coma y los segundos por si alguna fila se escribió con
// una variante ligeramente distinta del formato.
function parseMarcaTemporal(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec((s || '').trim());
  if (!m) return null;
  const [, d, mes, y, h, min, sec] = m;
  return new Date(Number(y), Number(mes) - 1, Number(d), Number(h), Number(min), Number(sec || 0)).getTime();
}

// GET ?accion=recientes — sesiones registradas por CUALQUIER cliente desde el
// lunes de esta semana hasta ahora, más recientes primero, para el panel de
// notificaciones de Seguimiento.html. Solo entrenador (ve datos de todos los
// clientes, no de uno).
async function manejarRecientes(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:AI`,
  });
  const filas = resp.data.values || [];
  const inicioSemana = lunesDe(new Date()).getTime();

  // Se necesita la marcaTemporal analizada para saber si algo es "de esta
  // semana" — a diferencia de la versión anterior (que solo cogía las
  // últimas filas tal cual), aquí una marcaTemporal sin interpretar sí queda
  // fuera, porque no hay forma de saber a qué semana pertenece.
  const sesiones = filas
    .map(f => ({ marcaTemporal: f[0], marcaTemporalMs: parseMarcaTemporal(f[0]), nombre: f[1], fecha: f[2], mesociclo: f[3], correo: f[COL_CORREO] }))
    .filter(s => s.marcaTemporalMs && s.marcaTemporalMs >= inicioSemana)
    .sort((a, b) => b.marcaTemporalMs - a.marcaTemporalMs);

  res.status(200).json({ success: true, sesiones });
}

// GET ?cliente= — histórico visual de TODAS las sesiones completadas por un
// cliente (con o sin datos — GYM-ANTAGONISTAS no lleva ningún dato, solo
// queda la fila con fecha y mesociclo, y eso ya vale para aparecer aquí).
async function manejarHistorialCliente(req, res, sheets) {
  const { cliente, limite } = req.query || {};
  const acceso = verificarAccesoCliente(req, cliente);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:AI`,
  });
  const filas = resp.data.values || [];
  const max = Number(limite) || 60;

  // Ordenamos por la fecha REAL de la sesión (no por el orden en que se
  // guardó la fila) — si alguien completa con retraso una sesión de días
  // atrás, esa fila se añade al final del Sheet aunque su fecha sea más
  // antigua, y el orden de inserción dejaba de coincidir con el
  // cronológico. Las filas sin fecha parseable se quedan al final.
  const historial = filas
    .filter(f => f[COL_CORREO] === cliente)
    .map(f => ({ fecha: f[2], mesociclo: f[3], marcaTemporal: f[0], _t: parseFechaDDMMYYYY(f[2]) }))
    .sort((a, b) => (b._t ?? -Infinity) - (a._t ?? -Infinity)) // más reciente primero
    .slice(0, max)
    .map(({ _t, ...resto }) => resto);

  res.status(200).json({ success: true, historial });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, accion } = req.query || {};
    if (accion !== 'recientes' && !cliente) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }

    const sheets = await authSheets(SCOPE_SOLO_LECTURA);

    if (accion === 'recientes') return await manejarRecientes(req, res, sheets);
    return await manejarHistorialCliente(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
