const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';

// Cada mesociclo ocupa un bloque fijo de columnas en el Sheet real (A=0, B=1, ...).
// De momento solo REOX está conectado; el resto se añaden en próximas sesiones de trabajo.
const MESOCICLOS = {
  REOX: {
    pfInicial: 13, // N
    fmaxDer: 14,   // O
    fmaxIzq: 15,   // P
    campo1: 16,    // Q - Suspensiones Intermitentes (series)
    campo2: 17,    // R - Campus HMH (series)
    campo3: 18,    // S - Travesías con sueltas (pegues)
    pfFinal: 19,   // T
  },
};

const TOTAL_COLUMNAS = 34; // A hasta AH

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }

    const { nombre, fecha, mesociclo, pfInicial, fmaxDer, fmaxIzq, campo1, campo2, campo3, pfFinal } = req.body || {};

    if (!nombre || !fecha || !mesociclo) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (nombre, fecha o mesociclo).' });
    }

    const columnas = MESOCICLOS[mesociclo];
    if (!columnas) {
      return res.status(400).json({ success: false, error: `El mesociclo "${mesociclo}" todavía no está conectado al Sheet.` });
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

    const fila = new Array(TOTAL_COLUMNAS).fill('');
    fila[0] = marcaTemporal; // A - Marca temporal
    fila[1] = nombre;        // B - Nombre y apellidos
    fila[2] = fecha;         // C - Fecha
    fila[3] = mesociclo;     // D - Mesociclo

    fila[columnas.pfInicial] = pfInicial !== undefined && pfInicial !== '' ? Number(pfInicial) : '';
    if (fmaxDer !== undefined) fila[columnas.fmaxDer] = fmaxDer;
    if (fmaxIzq !== undefined) fila[columnas.fmaxIzq] = fmaxIzq;
    if (campo1 !== undefined) fila[columnas.campo1] = campo1;
    if (campo2 !== undefined) fila[columnas.campo2] = campo2;
    if (campo3 !== undefined) fila[columnas.campo3] = campo3;
    if (pfFinal !== undefined && pfFinal !== '') fila[columnas.pfFinal] = Number(pfFinal);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:AH`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [fila] },
    });

    res.status(200).json({ success: true, message: 'Sesión guardada correctamente en el Sheet.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
