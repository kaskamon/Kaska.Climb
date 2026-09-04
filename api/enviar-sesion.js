const { google } = require('googleapis');
const { COLUMNS: MESOCICLOS } = require('../libs/mesociclos-config.js');
const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const TOTAL_COLUMNAS = 35; // A hasta AI (AI = correo, columna añadida al final para no mover nada de A-AH)
const COL_CORREO = 34; // AI — identificador real del cliente (el nombre en B es solo para leer a simple vista)

// El mapeo de columnas por mesociclo vive ahora en libs/mesociclos-config.js
// (fuente única, la reutilizan también los endpoints de lectura de sesión).

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
    const { nombre, correo, fecha, mesociclo, pfInicial, fmaxDer, fmaxIzq, campos, pfFinal, unico } = body;

    if (!nombre || !fecha || !mesociclo) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (nombre, fecha o mesociclo).' });
    }
    if (correo) {
      const acceso = verificarAccesoCliente(req, correo);
      if (!acceso.ok) {
        return res.status(401).json({ success: false, error: acceso.error });
      }
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
    fila[1] = nombre;        // B — nombre legible, para leer el Sheet a simple vista
    fila[2] = fecha;         // C
    fila[3] = mesociclo;     // D
    if (correo) fila[COL_CORREO] = correo; // AI — identificador real, usado por obtener-historial.js

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
        range: `'${SHEET_NAME}'!A:AI`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
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
        insertDataOption: 'INSERT_ROWS',
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
