const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Sesiones_Programadas';

// Devuelve la última sesión publicada de un cliente para un mesociclo (la más
// reciente por orden de fila, sin importar la fecha) — para poder partir de ahí
// en vez de una plantilla en blanco, tanto en Sesiones.html como al publicar
// una semana entera desde Semanas.html.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, mesociclo } = req.query || {};

    if (!cliente || !mesociclo) {
      return res.status(400).json({ success: false, error: 'Faltan parámetros (cliente o mesociclo).' });
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

    let jsonCrudo = null;
    let fechaEncontrada = null;
    for (let i = filas.length - 1; i >= 0; i--) {
      const fila = filas[i];
      if (fila[1] === cliente && fila[3] === mesociclo) {
        jsonCrudo = fila[5];
        fechaEncontrada = fila[2];
        break;
      }
    }

    if (!jsonCrudo) {
      return res.status(404).json({
        success: false,
        error: 'Este cliente todavía no tiene ninguna sesión publicada de este mesociclo.',
      });
    }

    let sesion;
    try {
      sesion = JSON.parse(jsonCrudo);
    } catch (e) {
      return res.status(500).json({ success: false, error: 'La última sesión publicada tiene un JSON inválido.' });
    }

    res.status(200).json({ success: true, sesion, fecha: fechaEncontrada });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
