// Copia de seguridad en crudo, una pestaña por tipo (Backups_BateriaTest,
// Backups_Macrociclo...) — independiente de si la escritura a las columnas
// propias de cada uno falla. Como mucho 1 backup por etiqueta (cliente+fecha):
// republicar lo mismo sobrescribe su backup en vez de acumular uno nuevo cada
// vez. Las pestañas se crean solas la primera vez que hace falta, igual que
// api/plantillas-sesion.js.
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';

async function asegurarPestanaBackup(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties.title' });
  const existe = (meta.data.sheets || []).some(s => s.properties.title === sheetName);
  if (existe) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
}

async function guardarBackup(sheets, sheetName, etiqueta, cuerpo) {
  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const fila = [marcaTemporal, etiqueta, JSON.stringify(cuerpo)];
  try {
    await asegurarPestanaBackup(sheets, sheetName);
    const existentes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:C`,
    });
    const filas = existentes.data.values || [];
    const idx = filas.findIndex(f => f[1] === etiqueta);
    if (idx !== -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${idx + 1}:C${idx + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fila] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] },
      });
    }
  } catch (e) { /* el backup nunca debe tumbar la publicación principal */ }
}

module.exports = { guardarBackup };
