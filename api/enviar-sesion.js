const { google } = require('googleapis');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const TOTAL_COLUMNAS = 34; // A hasta AH

// Cada mesociclo apunta a su bloque fijo de columnas real en el Sheet (A=0, B=1, ...).
// "campos" son los datos intermedios propios de cada ciclo, en el mismo orden
// en que los manda cada página de sesión.
const MESOCICLOS = {
  FMAX:  { pfInicial: 6,  fmaxDer: 7,  fmaxIzq: 8,  campos: [9, 10, 11],      pfFinal: 12 }, // SuspMax, Saltos a regleta, Boulder max
  REOX:  { pfInicial: 13, fmaxDer: 14, fmaxIzq: 15, campos: [16, 17, 18],     pfFinal: 19 }, // SuspInt OT, Campus HMH, Travesías con sueltas
  DESOX: { pfInicial: 20, fmaxDer: 21, fmaxIzq: 22, campos: [23, 24, 25, 26], pfFinal: 27 }, // SuspSub, Campus McClure, Travesías sin sueltas, Multibloque
  AERO:  { pfInicial: 28, fmaxDer: 29, fmaxIzq: 30, campos: [31, 32] },                      // SuspInt CF, Escalada continua — sin PFfinal
  'GYM-FMAX':         { unico: 4 },  // E - Dominadas con lastre
  'GYM-ANTAGONISTAS': {},            // sin columnas de datos, solo queda registrada la fila
};

// Backup crudo: guardamos también el JSON completo de lo que envía el cliente en
// la pestaña "Backups", independiente de si el volcado a columnas de arriba falla.
const BACKUP_SHEET_NAME = 'Backups';

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

    const body = req.body || {};
    const { nombre, fecha, mesociclo, pfInicial, fmaxDer, fmaxIzq, campos, pfFinal, unico } = body;

    if (!nombre || !fecha || !mesociclo) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (nombre, fecha o mesociclo).' });
    }

    const cfg = MESOCICLOS[mesociclo];
    if (!cfg) {
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
    const num = v => (v !== undefined && v !== null && v !== '') ? Number(v) : undefined;

    const fila = new Array(TOTAL_COLUMNAS).fill('');
    fila[0] = marcaTemporal; // A
    fila[1] = nombre;        // B
    fila[2] = fecha;         // C
    fila[3] = mesociclo;     // D

    // Los valores de fuerza (N) viajan tal cual — es tu Sheet quien calcula el %
    // comparando con el historial real, no lo calculamos aquí.
    if (cfg.pfInicial !== undefined) {
      const n = num(pfInicial);
      if (n !== undefined) fila[cfg.pfInicial] = n;
    }
    if (cfg.fmaxDer !== undefined) { const n = num(fmaxDer); if (n !== undefined) fila[cfg.fmaxDer] = n; }
    if (cfg.fmaxIzq !== undefined) { const n = num(fmaxIzq); if (n !== undefined) fila[cfg.fmaxIzq] = n; }
    if (cfg.campos && Array.isArray(campos)) {
      cfg.campos.forEach((col, i) => {
        const n = num(campos[i]);
        if (n !== undefined) fila[col] = n;
      });
    }
    if (cfg.pfFinal !== undefined) {
      const n = num(pfFinal);
      if (n !== undefined) fila[cfg.pfFinal] = n;
    }
    if (cfg.unico !== undefined) {
      const n = num(unico);
      if (n !== undefined) fila[cfg.unico] = n;
    }

    // 1) Escritura real en las columnas del Sheet
    let sheetOk = true;
    let sheetError = null;
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A:AH`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fila] },
      });
    } catch (e) {
      sheetOk = false;
      sheetError = e.message;
    }

    // 2) Copia de seguridad en crudo (independiente de si lo anterior ha fallado)
    let backupOk = true;
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${BACKUP_SHEET_NAME}'!A:C`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[marcaTemporal, `${nombre} — ${mesociclo}`, JSON.stringify(body)]] },
      });
    } catch (e) {
      backupOk = false;
    }

    if (!sheetOk) {
      return res.status(500).json({
        success: false,
        error: `No se pudo escribir en las columnas del Sheet (${sheetError}).` +
               (backupOk ? ' Aun así, se ha guardado una copia de seguridad completa en la pestaña "Backups".' : ' La copia de seguridad tampoco se pudo guardar.'),
      });
    }

    res.status(200).json({ success: true, message: 'Sesión guardada correctamente en el Sheet.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
