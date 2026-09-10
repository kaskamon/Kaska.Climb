const { google } = require('googleapis');

// Plantillas libres creadas en Sesiones.html (sin cliente ni mesociclo — ver
// esa página) — pestaña propia, distinta de Sesiones_Programadas (que es
// donde vive lo ya publicado a un cliente concreto). Columnas: A marcaTemporal,
// B nombre, C json (el objeto {tituloPrincipal, partes} tal cual lo exporta
// Sesiones.html, en texto).
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Plantillas_Sesiones';

function authSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient().then(authClient => google.sheets({ version: 'v4', auth: authClient }));
}

// GET sin ?nombre: lista ligera (nombre + fecha) para el desplegable — nunca
// manda el JSON completo de cada plantilla, para no cargar de más.
// GET ?nombre=X: la plantilla completa.
async function manejarGet(req, res, sheets) {
  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:C`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}). ¿Existe esa pestaña en el Sheet?`,
    });
  }

  const { nombre } = req.query || {};

  if (!nombre) {
    const plantillas = filas
      .filter(f => (f[1] || '').trim())
      .map(f => ({ nombre: f[1], marcaTemporal: f[0] || '' }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return res.status(200).json({ success: true, plantillas });
  }

  const nombreBuscado = nombre.trim().toLowerCase();
  const fila = filas.find(f => (f[1] || '').trim().toLowerCase() === nombreBuscado);
  if (!fila) {
    return res.status(404).json({ success: false, error: `No existe ninguna plantilla llamada "${nombre}".` });
  }

  let datos;
  try {
    datos = JSON.parse(fila[2]);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'La plantilla guardada tiene un JSON inválido.' });
  }

  res.status(200).json({ success: true, datos, marcaTemporal: fila[0] || '' });
}

// POST { nombre, datos } — guarda (sobrescribe si ya existe una plantilla con
// ese nombre exacto, o crea una fila nueva si no). Es justo lo que quiere
// "Guardar" en Sesiones.html: un solo botón, sin "Guardar como" aparte.
async function manejarPost(req, res, sheets) {
  const { nombre, datos } = req.body || {};
  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ success: false, error: 'Ponle un título a la tabla antes de guardar.' });
  }
  if (!datos || typeof datos !== 'object') {
    return res.status(400).json({ success: false, error: 'Faltan los datos de la tabla.' });
  }

  const nombreLimpio = String(nombre).trim();
  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const fila = [marcaTemporal, nombreLimpio, JSON.stringify(datos)];

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:C`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}). ¿Existe esa pestaña en el Sheet?`,
    });
  }

  const nombreBuscado = nombreLimpio.toLowerCase();
  const indiceFila = filas.findIndex(f => (f[1] || '').trim().toLowerCase() === nombreBuscado);
  // Escribimos en la fila exacta (existente o la siguiente libre) con
  // values.update en vez de values.append — mismo motivo que api/listar-
  // clientes.js: evita que Sheets adivine mal dónde va la fila nueva.
  const filaDestino = indiceFila !== -1 ? indiceFila + 1 : filas.length + 1;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A${filaDestino}:C${filaDestino}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [fila] },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo guardar la plantilla (${e.message}).` });
  }

  res.status(200).json({ success: true, message: indiceFila !== -1 ? 'Plantilla actualizada.' : 'Plantilla guardada.' });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET o POST.' });
  }

  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }
    const sheets = await authSheets();
    if (req.method === 'GET') return await manejarGet(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
