const { verificarEntrenador } = require('../libs/sesion-cliente.js');
const { authSheets: authSheetsCacheado, SCOPE_LECTURA_ESCRITURA } = require('../libs/sheets-auth.js');
const { sanearFormula } = require('../libs/sheets-sanitize.js');

// Batería de test completa (Batería test.html) — sustituye el ir exportando/
// importando archivos JSON sueltos. Columnas: A marcaTemporal, B correo,
// C nombre, D fecha (el campo "Fecha" de Datos del cliente — fecha REAL del
// test), E datos (JSON con el valor de cada input/select del formulario,
// tal cual el antiguo export a fichero). Un perfil por cliente+fecha: si ya
// existe una fila con esa misma fecha (p.ej. se retoca el mismo test y se
// vuelve a publicar), se sobrescribe en vez de duplicarla — un test en OTRA
// fecha sí crea una fila nueva, para poder ver la evolución del cliente.
// "Cargar" siempre trae el más reciente. Herramienta solo para el
// entrenador (igual que Macrociclos.html) — nunca la consulta el cliente.
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Bateria_Test';

// Sheet de clientes (distinto del de sesiones/batería) — mismo que usa
// api/listar-clientes.js, solo para el arranque automático del contrato.
const CLIENTES_SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const CLIENTES_SHEET_NAME = 'Respuestas de formulario 1';
const COL_CLIENTES_CORREO = 6, COL_CLIENTES_FECHA_INICIO = 12;

function authSheets() {
  return authSheetsCacheado(SCOPE_LECTURA_ESCRITURA);
}

// GET ?cliente=correo — el perfil de batería más reciente de ese cliente (o null si no tiene).
async function manejarGet(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }
  const { cliente } = req.query || {};
  if (!cliente) {
    return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
  }

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

  // g-fecha es un <input type="date"> (yyyy-mm-dd), así que compararlas como
  // texto ya da el orden cronológico correcto — sin parsear nada.
  const correoBuscado = cliente.trim().toLowerCase();
  let filaEncontrada = null;
  filas.forEach(f => {
    if ((f[1] || '').trim().toLowerCase() !== correoBuscado) return;
    if (!filaEncontrada || (f[3] || '') > (filaEncontrada[3] || '')) filaEncontrada = f;
  });

  if (!filaEncontrada) {
    return res.status(200).json({ success: true, datos: null });
  }

  let datos;
  try {
    datos = JSON.parse(filaEncontrada[4] || '{}');
  } catch (e) {
    return res.status(500).json({ success: false, error: 'El perfil guardado tiene un JSON inválido.' });
  }

  res.status(200).json({ success: true, datos, fecha: filaEncontrada[3] || '', marcaTemporal: filaEncontrada[0] || '' });
}

// POST — publica (sobrescribe) el perfil de batería de un cliente para una fecha.
async function manejarPost(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }
  const { correo, nombre, datos } = req.body || {};
  if (!correo || !datos || typeof datos !== 'object') {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (correo o datos).' });
  }
  const fecha = datos['g-fecha'] || '';
  if (!fecha) {
    return res.status(400).json({ success: false, error: 'Rellena la fecha (en Datos del cliente) antes de publicar.' });
  }

  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const correoNorm = correo.trim().toLowerCase();
  const fila = [marcaTemporal, sanearFormula(correo.trim()), sanearFormula(nombre || ''), sanearFormula(fecha), JSON.stringify(datos)];

  try {
    let filaExistente = null;
    const existentes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:E`,
    });
    const filas = existentes.data.values || [];
    const idx = filas.findIndex(f => (f[1] || '').trim().toLowerCase() === correoNorm && (f[3] || '') === fecha);
    if (idx !== -1) filaExistente = idx + 1; // fila real del Sheet (1-based)

    if (filaExistente) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A${filaExistente}:E${filaExistente}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fila] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A:E`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] },
      });
    }
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo publicar el perfil (${e.message}). ¿Existe la pestaña "${SHEET_NAME}" en el Sheet?`,
    });
  }

  // Arranque automático del contrato: la Batería de test es la prueba
  // inicial, previa a empezar a entrenar de verdad — si el cliente todavía
  // no tiene fecha de inicio en su ficha, se fija a la fecha REAL del test
  // (no "hoy", la que ha puesto el entrenador en "Datos del cliente") y
  // fin = inicio+3 meses (trimestre inicial). Nunca pisa una fecha ya
  // puesta. Si esto falla, no debe tumbar la publicación de la batería (ya
  // guardada).
  try {
    const [y, m, d] = fecha.split('-').map(Number);
    const fechaTest = y && m && d ? new Date(y, m - 1, d) : null;
    if (fechaTest) {
      const respClientes = await sheets.spreadsheets.values.get({
        spreadsheetId: CLIENTES_SPREADSHEET_ID,
        range: `'${CLIENTES_SHEET_NAME}'!A:N`,
      });
      const filasClientes = respClientes.data.values || [];
      const indiceCliente = filasClientes.findIndex(f => (f[COL_CLIENTES_CORREO] || '').trim().toLowerCase() === correoNorm);

      if (indiceCliente !== -1 && !(filasClientes[indiceCliente][COL_CLIENTES_FECHA_INICIO] || '').trim()) {
        const formatear = dt => `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
        const fin = new Date(fechaTest);
        fin.setMonth(fin.getMonth() + 3);
        const filaSheetClientes = indiceCliente + 1;

        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: CLIENTES_SPREADSHEET_ID,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [
              { range: `'${CLIENTES_SHEET_NAME}'!M${filaSheetClientes}`, values: [[formatear(fechaTest)]] },
              { range: `'${CLIENTES_SHEET_NAME}'!N${filaSheetClientes}`, values: [[formatear(fin)]] },
            ],
          },
        });
      }
    }
  } catch (e) {
    // Se ignora a propósito: la publicación de la batería ya se completó.
  }

  res.status(200).json({ success: true, message: 'Perfil de batería publicado correctamente.' });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET o POST.' });
  }

  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }
    const sheets = await authSheets();
    if (req.method === 'GET') return await manejarGet(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
