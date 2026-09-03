const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Pestaña nueva (hay que crearla a mano). Columnas: A marcaTemporal,
// B cliente (email), C fechaInicio (dd/mm/aaaa, el lunes en que arranca el
// macrociclo completo del cliente). Una fila por publicación — si se publica
// varias veces para el mismo cliente, la lectura se queda con la última.
const SHEET_NAME = 'Macrociclos_Cliente';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    const { cliente, fechaInicio } = req.body || {};

    if (!cliente || !fechaInicio) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (cliente o fechaInicio).' });
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
      range: `'${SHEET_NAME}'!A:C`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[marcaTemporal, cliente, fechaInicio]] },
    });

    res.status(200).json({ success: true, message: 'Fecha de inicio del macrociclo guardada correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
