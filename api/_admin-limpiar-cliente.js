const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Sesiones_Programadas';

// Herramienta de un solo uso: borra TODAS las filas de un cliente en
// Sesiones_Programadas. Se usa desde el navegador una vez y se elimina el
// archivo después — no queda en producción de forma permanente.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    const { cliente } = req.body || {};
    if (!cliente) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({ success: false, error: 'Faltan variables de entorno.' });
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

    const [meta, resp] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:G` }),
    ]);
    const hoja = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
    const filas = resp.data.values || [];
    const indices = [];
    filas.forEach((f, i) => { if (f[1] === cliente) indices.push(i); });

    if (hoja && indices.length) {
      const sheetId = hoja.properties.sheetId;
      const requests = indices
        .sort((a, b) => b - a)
        .map(i => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
    }

    res.status(200).json({ success: true, borradas: indices.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
