const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Perfiles_Fisiologicos';

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d).getTime();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, modalidad } = req.query || {};
    if (!cliente || !modalidad) {
      return res.status(400).json({ success: false, error: 'Faltan parámetros (cliente o modalidad).' });
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
        range: `'${SHEET_NAME}'!A:E`,
      });
      filas = resp.data.values || [];
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}). ¿Existe esa pestaña en el Sheet?`,
      });
    }

    // Si el mismo día se ha guardado más de una vez, nos quedamos con la más
    // reciente (por orden de fila) para esa fecha exacta.
    const porFecha = new Map();
    filas.forEach(f => {
      const filaCliente = f[1], filaFecha = f[2], filaModalidad = f[3], filaJson = f[4];
      if (filaCliente !== cliente || filaModalidad !== modalidad) return;
      let capacidades;
      try { capacidades = JSON.parse(filaJson); } catch (e) { return; }
      porFecha.set(filaFecha, { fecha: filaFecha, capacidades });
    });

    const perfiles = Array.from(porFecha.values())
      .sort((a, b) => (parseFechaDDMMYYYY(a.fecha) || 0) - (parseFechaDDMMYYYY(b.fecha) || 0));

    res.status(200).json({ success: true, perfiles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
