const { COLUMNS: MESOCICLOS } = require('../libs/mesociclos-config.js');
const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');
const { authSheets, SCOPE_LECTURA_ESCRITURA } = require('../libs/sheets-auth.js');
const { sanearFormula } = require('../libs/sheets-sanitize.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const TOTAL_COLUMNAS = 36; // A hasta AJ (AI = correo, AJ = notas — ambas añadidas al final para no mover nada de A-AH)
const COL_CORREO = 34; // AI — identificador real del cliente (el nombre en B es solo para leer a simple vista)
const COL_NOTAS = 35; // AJ — nota libre opcional del cliente ("cómo me he sentido...")

// El mapeo de columnas por mesociclo vive ahora en libs/mesociclos-config.js
// (fuente única, la reutilizan también los endpoints de lectura de sesión).

// "Dominadas con lastre" (bloque "Fmax tracción") ya no depende de que el
// mesociclo sea literalmente GYM-FMAX — ese bloque puede aparecer en
// cualquier sesión de gimnasio, y siempre escribe en la misma columna, solo
// si el cliente mandó ese dato (ver CAMPO_UNICO_GLOBAL en cliente/sesion.html).
const COL_DOMINADAS_CON_LASTRE = 4; // E

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
    const { nombre, correo, fecha, mesociclo, pfInicial, fmaxDer, fmaxIzq, campos, pfFinal, unico, notas } = body;

    if (!nombre || !fecha || !mesociclo || !correo) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (nombre, correo, fecha o mesociclo).' });
    }
    const acceso = verificarAccesoCliente(req, correo);
    if (!acceso.ok) {
      return res.status(401).json({ success: false, error: acceso.error });
    }

    const cfg = MESOCICLOS[mesociclo];
    if (!cfg) {
      return res.status(400).json({ success: false, error: `El mesociclo "${mesociclo}" todavía no está conectado al Sheet.` });
    }

    const sheets = await authSheets(SCOPE_LECTURA_ESCRITURA);

    const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    // Por si algún valor llega como texto con coma decimal (teclado en
    // español) en vez de ya convertido a número — Number("64,5") da NaN, que
    // JSON.stringify convierte en null al mandarlo al Sheet. Se normaliza a
    // "." y se descarta si sigue sin ser un número válido, en vez de escribir
    // NaN/null en la columna.
    const num = v => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(String(v).replace(',', '.'));
      return isNaN(n) ? undefined : n;
    };

    const fila = new Array(TOTAL_COLUMNAS).fill('');
    fila[0] = marcaTemporal; // A
    fila[1] = sanearFormula(nombre); // B — nombre legible, para leer el Sheet a simple vista
    fila[2] = sanearFormula(fecha);  // C
    fila[3] = sanearFormula(mesociclo); // D
    if (correo) fila[COL_CORREO] = sanearFormula(correo); // AI — identificador real, usado por obtener-historial.js
    if (notas && String(notas).trim()) fila[COL_NOTAS] = sanearFormula(String(notas).trim().slice(0, 2000)); // AJ

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
    if (cfg.unico !== undefined || unico !== undefined) {
      const n = num(unico);
      if (n !== undefined) fila[cfg.unico !== undefined ? cfg.unico : COL_DOMINADAS_CON_LASTRE] = n;
    }

    // 0) Si ya hay una entrada para este cliente/fecha/mesociclo exactos, la
    // sobrescribimos en vez de duplicarla — rellenar la misma sesión dos
    // veces el mismo día reemplaza los datos, no los suma. Un mesociclo
    // repetido en otro día (p.ej. la parte analítica varias veces en la
    // semana) sigue contando como una fila nueva, porque la fecha no coincide.
    let filaExistente = null;
    if (correo) {
      try {
        const existentes = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${SHEET_NAME}'!A:AJ`,
        });
        const filas = existentes.data.values || [];
        const idx = filas.findIndex(f => f[COL_CORREO] === correo && f[2] === fecha && f[3] === mesociclo);
        if (idx !== -1) filaExistente = idx + 1; // fila real del Sheet (1-based)
      } catch (e) {
        // Si falla la búsqueda, seguimos con el comportamiento normal (añadir)
      }
    }

    // 1) Escritura real en las columnas del Sheet
    let sheetOk = true;
    let sheetError = null;
    try {
      if (filaExistente) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${SHEET_NAME}'!A${filaExistente}:AJ${filaExistente}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [fila] },
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${SHEET_NAME}'!A:AJ`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [fila] },
        });
      }
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
        requestBody: { values: [[marcaTemporal, sanearFormula(`${nombre} — ${mesociclo}`), JSON.stringify(body)]] },
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

    res.status(200).json({
      success: true,
      message: filaExistente
        ? 'Ya habías enviado esta sesión hoy — se ha actualizado con los nuevos datos.'
        : 'Sesión guardada correctamente en el Sheet.',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
