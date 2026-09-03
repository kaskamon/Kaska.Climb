const { google } = require('googleapis');
const { COLUMNS } = require('../libs/mesociclos-config.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const COL_CORREO = 34; // AI — mismo campo que escribe api/enviar-sesion.js

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    // "cliente" aquí es el email del cliente — es el identificador real en toda
    // la app (el nombre en columna B es solo para leer el Sheet a simple vista).
    const { cliente, mesociclo, limite } = req.query || {};

    if (!cliente || !mesociclo) {
      return res.status(400).json({ success: false, error: 'Faltan parámetros (cliente o mesociclo).' });
    }

    const cfg = COLUMNS[mesociclo];
    if (!cfg || cfg.pfInicial === undefined) {
      // Mesociclos de gimnasio (GYM-FMAX, GYM-ANTAGONISTAS) no miden PFinicial —
      // no hay historial de recuperación que calcular para ellos.
      return res.status(200).json({ success: true, historial: [] });
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
    const max = Number(limite) || 10;

    const historial = filas
      .filter(f => f[COL_CORREO] === cliente && f[3] === mesociclo && f[cfg.pfInicial] !== undefined && f[cfg.pfInicial] !== '')
      .map(f => {
        // Si ese día se registró algo más allá del PFinicial (p.ej. la Fmax), la
        // sesión se entrenó de verdad. Si no, fue un día bloqueado por no estar
        // recuperado, y no cuenta como referencia para sesiones futuras.
        const fmaxIzq = cfg.fmaxIzq !== undefined ? f[cfg.fmaxIzq] : undefined;
        const fmaxDer = cfg.fmaxDer !== undefined ? f[cfg.fmaxDer] : undefined;
        const entrenada = fmaxIzq !== undefined && fmaxIzq !== '';
        return {
          fecha: f[2],
          pfInicial: Number(f[cfg.pfInicial]),
          entrenada,
          fmaxIzq: fmaxIzq !== undefined && fmaxIzq !== '' ? Number(fmaxIzq) : undefined,
          fmaxDer: fmaxDer !== undefined && fmaxDer !== '' ? Number(fmaxDer) : undefined,
        };
      })
      .slice(-max);

    res.status(200).json({ success: true, historial });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
