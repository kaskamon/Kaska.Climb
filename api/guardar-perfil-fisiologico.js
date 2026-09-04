const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Pestaña nueva (hay que crearla a mano en el Sheet). Columnas: A marcaTemporal
// (cuándo se guardó, automático), B cliente (email), C fecha (fecha REAL de
// realización del test, la introduce el entrenador a mano — nunca la de
// guardado/exportación), D modalidad ("deportiva" | "boulder"),
// E capacidades (JSON: {fmax, rfd, ...}, las claves cambian según modalidad).
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

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:E`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[marcaTemporal, cliente, fecha, modalidad, JSON.stringify(capacidades)]] },
    });

    res.status(200).json({ success: true, message: 'Perfil fisiológico guardado correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
