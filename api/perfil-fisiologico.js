const { google } = require('googleapis');
const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');

// Perfil fisiológico (test de fuerza/resistencia) por cliente — lo consulta
// el propio cliente en cliente/perfil-fisiologico.html (histórico, para las
// comparativas de progreso) y lo publica el entrenador desde "Batería test.html".
// Unido en un solo endpoint (antes eran obtener-perfiles-fisiologicos.js y
// guardar-perfil-fisiologico.js) para no pasarnos del límite de funciones
// serverless del plan de Vercel.
//
// Pestaña "Perfiles_Fisiologicos" (hay que crearla a mano en el Sheet).
// Columnas: A marcaTemporal (cuándo se guardó, automático), B cliente
// (email), C fecha (fecha REAL de realización del test, la introduce el
// entrenador a mano — nunca la de guardado/publicación), D modalidad
// ("deportiva" | "boulder"), E capacidades (JSON: {fmax, rfd, ...}, las
// claves cambian según modalidad).
//
// Un perfil por cliente+fecha+modalidad: si ya existe una fila para esa
// combinación (p.ej. se publica dos veces el mismo test), se sobrescribe en
// vez de duplicarla — un test en otra fecha sí crea una fila nueva, porque
// eso es historial real para las comparativas de progreso.
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Perfiles_Fisiologicos';

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d).getTime();
}

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

// GET ?cliente=&modalidad= — historial completo (uno por fecha) de ese cliente/modalidad.
async function manejarGet(req, res, sheets) {
  const { cliente, modalidad } = req.query || {};
  if (!cliente || !modalidad) {
    return res.status(400).json({ success: false, error: 'Faltan parámetros (cliente o modalidad).' });
  }
  const acceso = verificarAccesoCliente(req, cliente);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:E`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}). ¿Existe esa pestaña en el Sheet?`,
    });
  }

  // Si el mismo día se ha guardado más de una vez, nos quedamos con la más
  // reciente (por orden de fila) para esa fecha exacta.
  const porFecha = new Map();
  filas.forEach(f => {
    const filaCliente = f[1], filaFecha = f[2], filaModalidad = f[3], filaJson = f[4];
    if (filaCliente !== cliente || filaModalidad !== modalidad) return;
    let capacidades;
    try { capacidades = JSON.parse(filaJson); } catch (e) { return; }
    porFecha.set(filaFecha, { fecha: filaFecha, capacidades });
  });

  const perfiles = Array.from(porFecha.values())
    .sort((a, b) => (parseFechaDDMMYYYY(a.fecha) || 0) - (parseFechaDDMMYYYY(b.fecha) || 0));

  res.status(200).json({ success: true, perfiles });
}

// POST — publica (sobrescribe si coincide fecha) el perfil de un cliente.
async function manejarPost(req, res, sheets) {
  const { cliente, fecha, modalidad, capacidades } = req.body || {};

  if (!cliente || !fecha || !modalidad || !capacidades) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (cliente, fecha, modalidad o capacidades).' });
  }

  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const fila = [marcaTemporal, cliente, fecha, modalidad, JSON.stringify(capacidades)];

  try {
    let filaExistente = null;
    const existentes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:E`,
    });
    const filas = existentes.data.values || [];
    const idx = filas.findIndex(f => f[1] === cliente && f[2] === fecha && f[3] === modalidad);
    if (idx !== -1) filaExistente = idx + 1; // fila real del Sheet (1-based)

    if (filaExistente) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A${filaExistente}:E${filaExistente}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fila] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A:E`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] },
      });
    }
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo guardar el perfil (${e.message}). ¿Existe la pestaña "${SHEET_NAME}" en el Sheet?`,
    });
  }

  res.status(200).json({ success: true, message: 'Perfil fisiológico guardado correctamente.' });
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
