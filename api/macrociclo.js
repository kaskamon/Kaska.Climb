const { google } = require('googleapis');

// Planificación de macrociclo por cliente (Macrociclos.html) — hoja principal,
// distinta de la de sesiones/historial. Columnas: A marcaTemporal, B correo,
// C nombre, D fechaInicio, E fechaFin, F bloques (JSON, [{fase,semanas}...]).
// Cada "Publicar" añade una fila nueva (no sustituye) para poder comparar
// macrociclos de años distintos del mismo cliente — "Cargar" siempre trae el
// más reciente.
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Macrociclos_Cliente';

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

// GET ?cliente=correo — el macrociclo más reciente de ese cliente.
async function manejarGet(req, res, sheets) {
  const { cliente } = req.query || {};
  if (!cliente) {
    return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
  }

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:F`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}). ¿Existe esa pestaña en el Sheet?`,
    });
  }

  const correoBuscado = cliente.trim().toLowerCase();
  let filaEncontrada = null;
  for (let i = filas.length - 1; i >= 0; i--) {
    if ((filas[i][1] || '').trim().toLowerCase() === correoBuscado) {
      filaEncontrada = filas[i];
      break;
    }
  }

  if (!filaEncontrada) {
    return res.status(200).json({ success: true, plan: null });
  }

  let bloques = [];
  try {
    bloques = JSON.parse(filaEncontrada[5] || '[]');
  } catch (e) {
    return res.status(500).json({ success: false, error: 'El plan guardado tiene un JSON inválido.' });
  }

  res.status(200).json({
    success: true,
    plan: {
      nombre: filaEncontrada[2] || '',
      inicio: filaEncontrada[3] || '',
      fin: filaEncontrada[4] || '',
      bloques,
    },
  });
}

// POST — publica (añade) un macrociclo nuevo para un cliente.
async function manejarPost(req, res, sheets) {
  const { correo, nombre, inicio, fin, bloques } = req.body || {};
  if (!correo || !nombre || !Array.isArray(bloques)) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (correo, nombre o bloques).' });
  }

  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[marcaTemporal, correo.trim(), nombre, inicio || '', fin || '', JSON.stringify(bloques)]] },
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo publicar el macrociclo (${e.message}). ¿Existe la pestaña "${SHEET_NAME}" en el Sheet?`,
    });
  }

  res.status(200).json({ success: true, message: 'Macrociclo publicado correctamente.' });
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
