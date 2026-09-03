const { google } = require('googleapis');
const { COLUMNS } = require('../libs/mesociclos-config.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Pestaña nueva (hay que crearla a mano en el Sheet) donde Semanas.html / Sesiones.html
// publican el guion de cada sesión concreta. Columnas: A marcaTemporal, B cliente,
// C fecha (dd/mm/aaaa), D mesociclo, E semana, F json (el objeto {tituloPrincipal, partes}
// tal cual lo exporta Sesiones.html, en texto).
const SHEET_NAME = 'Sesiones_Programadas';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, fecha, mesociclo } = req.query || {};

    if (!cliente || !fecha || !mesociclo) {
      return res.status(400).json({ success: false, error: 'Faltan parámetros (cliente, fecha o mesociclo).' });
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

    // De abajo a arriba: si se ha publicado más de una vez para el mismo
    // cliente/fecha/mesociclo, nos quedamos con la más reciente.
    let jsonCrudo = null;
    for (let i = filas.length - 1; i >= 0; i--) {
      const fila = filas[i];
      if (fila[1] === cliente && fila[2] === fecha && fila[3] === mesociclo) {
        jsonCrudo = fila[5];
        break;
      }
    }

    if (!jsonCrudo) {
      return res.status(404).json({
        success: false,
        error: 'No hay ninguna sesión publicada para ese cliente, fecha y mesociclo.',
      });
    }

    let sesion;
    try {
      sesion = JSON.parse(jsonCrudo);
    } catch (e) {
      return res.status(500).json({ success: false, error: 'La sesión publicada tiene un JSON inválido.' });
    }

    res.status(200).json({ success: true, sesion });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
