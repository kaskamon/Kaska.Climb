const { google } = require('googleapis');
const { COLUMNS } = require('../libs/mesociclos-config.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Misma pestaña que lee api/obtener-sesion.js. Columnas: A marcaTemporal,
// B cliente, C fecha (dd/mm/aaaa), D mesociclo, E semana (sin usar por ahora),
// F json (el objeto {tituloPrincipal, partes} tal cual lo exporta Sesiones.html).
const SHEET_NAME = 'Sesiones_Programadas';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    const { cliente, fecha, mesociclo, sesion } = req.body || {};

    if (!cliente || !fecha || !mesociclo || !sesion) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (cliente, fecha, mesociclo o sesion).' });
    }
    if (!COLUMNS[mesociclo]) {
      return res.status(400).json({ success: false, error: `El mesociclo "${mesociclo}" no existe.` });
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

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:F`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[marcaTemporal, cliente, fecha, mesociclo, '', JSON.stringify(sesion)]] },
    });

    res.status(200).json({ success: true, message: 'Sesión publicada correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
