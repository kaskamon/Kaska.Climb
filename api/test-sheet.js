const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Test conexión';

module.exports = async (req, res) => {
  try {
    const auth = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      // La clave se guarda en Vercel con \n como texto literal; hay que
      // convertirlos a saltos de línea reales para que la librería la acepte.
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });

    const ahora = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:C`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['Conexión de prueba', ahora, 'OK']],
      },
    });

    res.status(200).json({ success: true, message: 'Fila escrita correctamente en el Sheet.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
