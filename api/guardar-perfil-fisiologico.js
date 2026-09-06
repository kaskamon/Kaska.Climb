const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Pestaña nueva (hay que crearla a mano en el Sheet). Columnas: A marcaTemporal
// (cuándo se guardó, automático), B cliente (email), C fecha (fecha REAL de
// realización del test, la introduce el entrenador a mano — nunca la de
// guardado/exportación), D modalidad ("deportiva" | "boulder"),
// E capacidades (JSON: {fmax, rfd, ...}, las claves cambian según modalidad).
// Un perfil por cliente+fecha+modalidad: si ya existe una fila para esa
// combinación (p.ej. se publica dos veces el mismo test), se sobrescribe en
// vez de duplicarla — un test en otra fecha sí crea una fila nueva, porque
// eso es historial real para las comparativas de progreso.
const SHEET_NAME = 'Perfiles_Fisiologicos';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    const { cliente, fecha, modalidad, capacidades } = req.body || {};

    if (!cliente || !fecha || !modalidad || !capacidades) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (cliente, fecha, modalidad o capacidades).' });
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    const fila = [marcaTemporal, cliente, fecha, modalidad, JSON.stringify(capacidades)];

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

    res.status(200).json({ success: true, message: 'Perfil fisiológico guardado correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
