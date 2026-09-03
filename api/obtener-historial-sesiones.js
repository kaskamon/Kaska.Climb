const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const COL_CORREO = 34; // AI — mismo campo que escribe api/enviar-sesion.js

// Histórico visual de TODAS las sesiones completadas por un cliente (con o sin
// datos — GYM-ANTAGONISTAS no lleva ningún dato, solo queda la fila con fecha
// y mesociclo, y eso ya vale para aparecer aquí).
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, limite } = req.query || {};
    if (!cliente) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:AI`,
    });
    const filas = resp.data.values || [];
    const max = Number(limite) || 60;

    const historial = filas
      .filter(f => f[COL_CORREO] === cliente)
      .map(f => ({ fecha: f[2], mesociclo: f[3], marcaTemporal: f[0] }))
      .slice(-max)
      .reverse(); // más reciente primero

    res.status(200).json({ success: true, historial });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
