const { google } = require('googleapis');
const { COLUMNS } = require('../libs/mesociclos-config.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Misma pestaña que lee api/obtener-sesion.js. Columnas: A marcaTemporal,
// B cliente, C fecha (dd/mm/aaaa), D mesociclo, E semana (la del macrociclo
// completo, tal cual la escribe el entrenador en Semanas.html), F json (el
// objeto {tituloPrincipal, partes} tal cual lo exporta Sesiones.html),
// G semanaMesociclo (p.ej. "3/6" — "Sem. Meso." de Semanas.html).
const SHEET_NAME = 'Sesiones_Programadas';

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}
function lunesDe(date) {
  const diaSemana = date.getDay(); // 0=domingo .. 6=sábado
  const offsetALunes = diaSemana === 0 ? -6 : 1 - diaSemana;
  const lunes = new Date(date);
  lunes.setDate(lunes.getDate() + offsetALunes);
  lunes.setHours(0, 0, 0, 0);
  return lunes;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    const { cliente, fecha, mesociclo, sesion, semana, semanaMesociclo } = req.body || {};

    if (!cliente || !fecha || !mesociclo || !sesion) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (cliente, fecha, mesociclo o sesion).' });
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Antes de escribir la versión nueva: (1) borramos cualquier fila que ya
    // hubiera para este mismo cliente+fecha+mesociclo, para no duplicar; y
    // (2) de paso aprovechamos para podar cualquier fila de este cliente más
    // vieja que las 2 últimas semanas — así solo queda esa semana en curso y
    // la anterior (suficiente para que un cliente pueda completar tarde algo
    // de la semana pasada), sin acumular datos sin límite. La ventana de "2
    // semanas" se cuenta desde HOY (no desde la fecha que se está
    // publicando), para que corregir algo antiguo nunca borre la semana
    // actual por error.
    const cortePorAntiguedad = lunesDe(new Date());
    cortePorAntiguedad.setDate(cortePorAntiguedad.getDate() - 7);

    const [meta, resp] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:G` }),
    ]);
    const hoja = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
    const filas = resp.data.values || [];
    const indicesABorrar = [];
    filas.forEach((f, i) => {
      if (f[1] !== cliente) return;
      const esMismoDiaYMeso = f[2] === fecha && f[3] === mesociclo;
      const fechaFila = parseFechaDDMMYYYY(f[2]);
      const esAntigua = fechaFila ? lunesDe(fechaFila) < cortePorAntiguedad : false;
      if (esMismoDiaYMeso || esAntigua) indicesABorrar.push(i);
    });

    if (hoja && indicesABorrar.length) {
      const sheetId = hoja.properties.sheetId;
      const requests = indicesABorrar
        .sort((a, b) => b - a) // de la fila más abajo hacia arriba, para no desplazar los índices que faltan por borrar
        .map(i => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
    }

    const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[marcaTemporal, cliente, fecha, mesociclo, semana || '', JSON.stringify(sesion), semanaMesociclo || '']] },
    });

    res.status(200).json({ success: true, message: 'Sesión publicada correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
