// Copia de seguridad en crudo en la pestaña "Backups", compartida por los
// endpoints que publican un perfil/plan completo de golpe (bateria-test.js,
// macrociclo.js) — independiente de si la escritura a sus columnas propias
// falla. Como mucho 1 backup por etiqueta (cliente+fecha): republicar lo
// mismo sobrescribe su backup en vez de acumular uno nuevo cada vez.
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const BACKUP_SHEET_NAME = 'Backups';

async function guardarBackup(sheets, etiqueta, cuerpo) {
  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const fila = [marcaTemporal, etiqueta, JSON.stringify(cuerpo)];
  try {
    const existentes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${BACKUP_SHEET_NAME}'!A:C`,
    });
    const filas = existentes.data.values || [];
    const idx = filas.findIndex(f => f[1] === etiqueta);
    if (idx !== -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${BACKUP_SHEET_NAME}'!A${idx + 1}:C${idx + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fila] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${BACKUP_SHEET_NAME}'!A:C`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] },
      });
    }
  } catch (e) { /* el backup nunca debe tumbar la publicación principal */ }
}

module.exports = { guardarBackup };
