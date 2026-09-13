const { google } = require('googleapis');
const { verificarAccesoCliente, verificarEntrenador } = require('../libs/sesion-cliente.js');
const { calcularFaseYSemana, semanasDelMacrociclo, lunesDe, parseFechaDDMMYYYY, formatFechaDDMMYYYY } = require('../libs/planificacion-semanas.js');

// Planificación de macrociclo por cliente (Macrociclos.html) — hoja principal,
// distinta de la de sesiones/historial. Columnas: A marcaTemporal, B correo,
// C nombre, D fechaInicio, E fechaFin, F bloques (JSON, [{fase,semanas}...]).
// Un macrociclo por cliente+fechaInicio: si ya existe una fila con esa misma
// fecha de inicio (p.ej. se retoca el mismo plan y se vuelve a publicar), se
// sobrescribe en vez de duplicarla — un macrociclo con OTRA fecha de inicio
// sí crea una fila nueva, para poder comparar macrociclos de años distintos
// del mismo cliente. "Cargar" siempre trae el más reciente.
const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Macrociclos_Cliente';
const SESIONES_PROGRAMADAS_SHEET = 'Sesiones_Programadas';

// Sheet de clientes (distinto del de sesiones/macrociclos) — mismo que usa
// api/listar-clientes.js.
const CLIENTES_SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const CLIENTES_SHEET_NAME = 'Respuestas de formulario 1';
const COL_CLIENTES = { estado: 1, nombre: 3, apellidos: 4, correo: 6 };

function authSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient().then(authClient => google.sheets({ version: 'v4', auth: authClient }));
}

// GET ?cliente=correo — el macrociclo más reciente de ese cliente.
async function manejarGet(req, res, sheets) {
  const { cliente } = req.query || {};
  if (!cliente) {
    return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
  }
  const acceso = verificarAccesoCliente(req, cliente);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:F`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}). ¿Existe esa pestaña en el Sheet?`,
    });
  }

  const correoBuscado = cliente.trim().toLowerCase();
  let filaEncontrada = null;
  for (let i = filas.length - 1; i >= 0; i--) {
    if ((filas[i][1] || '').trim().toLowerCase() === correoBuscado) {
      filaEncontrada = filas[i];
      break;
    }
  }

  if (!filaEncontrada) {
    return res.status(200).json({ success: true, plan: null });
  }

  let bloques = [];
  try {
    bloques = JSON.parse(filaEncontrada[5] || '[]');
  } catch (e) {
    return res.status(500).json({ success: false, error: 'El plan guardado tiene un JSON inválido.' });
  }

  res.status(200).json({
    success: true,
    plan: {
      nombre: filaEncontrada[2] || '',
      inicio: filaEncontrada[3] || '',
      fin: filaEncontrada[4] || '',
      bloques,
    },
  });
}

// POST — publica (añade) un macrociclo nuevo para un cliente.
async function manejarPost(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }
  const { correo, nombre, inicio, fin, bloques } = req.body || {};
  if (!correo || !nombre || !Array.isArray(bloques)) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (correo, nombre o bloques).' });
  }

  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const correoNorm = correo.trim().toLowerCase();
  const fila = [marcaTemporal, correo.trim(), nombre, inicio || '', fin || '', JSON.stringify(bloques)];

  try {
    let filaExistente = null;
    const existentes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:F`,
    });
    const filas = existentes.data.values || [];
    const idx = filas.findIndex(f => (f[1] || '').trim().toLowerCase() === correoNorm && (f[3] || '') === (inicio || ''));
    if (idx !== -1) filaExistente = idx + 1; // fila real del Sheet (1-based)

    if (filaExistente) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A${filaExistente}:F${filaExistente}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [fila] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NAME}'!A:F`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [fila] },
      });
    }
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo publicar el macrociclo (${e.message}). ¿Existe la pestaña "${SHEET_NAME}" en el Sheet?`,
    });
  }

  res.status(200).json({ success: true, message: 'Macrociclo publicado correctamente.' });
}

// Una única lectura (en paralelo) de clientes activos + todos los
// macrociclos + todas las semanas ya publicadas — la usan tanto el aviso de
// "semana siguiente sin publicar" como la rejilla de Programación, para no
// repetir una llamada a Sheets por cliente.
async function datosBaseParaRevision(sheets) {
  const [respClientes, respMacros, respProgramadas] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: CLIENTES_SPREADSHEET_ID, range: `'${CLIENTES_SHEET_NAME}'!A:N` }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:F` }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SESIONES_PROGRAMADAS_SHEET}'!A:D` }),
  ]);

  const clientesActivos = (respClientes.data.values || [])
    .filter(f => (f[COL_CLIENTES.estado] || '').trim().toLowerCase() === 'activo' && (f[COL_CLIENTES.correo] || '').trim())
    .map(f => ({
      correo: (f[COL_CLIENTES.correo] || '').trim(),
      nombre: [(f[COL_CLIENTES.nombre] || '').trim(), (f[COL_CLIENTES.apellidos] || '').trim()].filter(Boolean).join(' '),
    }));

  // Último macrociclo (por orden de fila) de cada cliente — igual que hace
  // manejarGet más arriba, pero para todos los clientes de una vez.
  const macrociclosPorCorreo = new Map();
  (respMacros.data.values || []).forEach(f => {
    const correo = (f[1] || '').trim().toLowerCase();
    if (!correo) return;
    let bloques;
    try { bloques = JSON.parse(f[5] || '[]'); } catch (e) { return; }
    macrociclosPorCorreo.set(correo, { nombre: f[2] || '', inicio: f[3] || '', fin: f[4] || '', bloques });
  });

  const semanasPublicadas = new Set(); // "correo|timestampDelLunes"
  (respProgramadas.data.values || []).forEach(f => {
    const correo = (f[1] || '').trim().toLowerCase();
    const fechaFila = parseFechaDDMMYYYY(f[2]);
    if (!correo || !fechaFila) return;
    semanasPublicadas.add(correo + '|' + lunesDe(fechaFila).getTime());
  });

  return { clientesActivos, macrociclosPorCorreo, semanasPublicadas };
}

// GET ?accion=revisar-semana-siguiente — botón "Revisar semana siguiente" en
// Seguimiento.html. Compara, para cada cliente activo con macrociclo, si la
// semana que empieza el próximo lunes (la primera que aún no ha llegado)
// está publicada en Sesiones_Programadas. No revisa huecos de semanas
// anteriores, solo esa. Solo a mano — sin cron ni correo: el entrenador
// prefiere mirarlo en la app cuando le convenga, no que le lleguen avisos.
async function manejarRevisarSemanaSiguiente(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });

  try {
    const { clientesActivos, macrociclosPorCorreo, semanasPublicadas } = await datosBaseParaRevision(sheets);

    const proximoLunes = lunesDe(new Date());
    proximoLunes.setDate(proximoLunes.getDate() + 7);
    const proximoLunesStr = formatFechaDDMMYYYY(proximoLunes);

    const pendientes = [];
    clientesActivos.forEach(c => {
      const plan = macrociclosPorCorreo.get(c.correo.toLowerCase());
      if (!plan || !plan.inicio) return;
      const calc = calcularFaseYSemana(plan.inicio, plan.bloques, proximoLunesStr);
      if (calc.fueraDeRango) return; // el macrociclo no cubre esa semana (aún no empieza o ya terminó)
      const key = c.correo.toLowerCase() + '|' + proximoLunes.getTime();
      if (!semanasPublicadas.has(key)) pendientes.push({ correo: c.correo, nombre: c.nombre });
    });

    res.status(200).json({ success: true, semanaProxima: proximoLunesStr, pendientes });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// GET ?accion=grid — datos para la rejilla visual de Programacion.html: por
// cada cliente activo con macrociclo, el desglose semana a semana con su fase
// y si está publicada. Llamada AJAX desde una página ya protegida por
// middleware.js, así que basta con el 401 JSON de verificarEntrenador (no
// hace falta el popup WWW-Authenticate de exigirEntrenador).
async function manejarGrid(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });

  try {
    const { clientesActivos, macrociclosPorCorreo, semanasPublicadas } = await datosBaseParaRevision(sheets);

    // Las filas de Sesiones_Programadas más viejas que esta ventana pueden
    // haber sido podadas por api/publicar-sesion.js (que borra, por cliente,
    // lo anterior a hoy-7d al publicar) sin que eso signifique que esa semana
    // nunca se publicó — no se puede distinguir, así que no se marcan en rojo.
    const cortePorAntiguedad = lunesDe(new Date());
    cortePorAntiguedad.setDate(cortePorAntiguedad.getDate() - 7);

    const clientes = clientesActivos
      .map(c => {
        const plan = macrociclosPorCorreo.get(c.correo.toLowerCase());
        if (!plan || !plan.inicio) return null;
        const { totalSemanas, semanas } = semanasDelMacrociclo(plan.inicio, plan.bloques);
        return {
          correo: c.correo,
          nombre: c.nombre || plan.nombre,
          totalSemanas,
          semanas: semanas.map(s => {
            const lunesFecha = parseFechaDDMMYYYY(s.fechaLunes);
            const key = c.correo.toLowerCase() + '|' + lunesFecha.getTime();
            return {
              ...s,
              publicada: semanasPublicadas.has(key),
              historica: lunesFecha < cortePorAntiguedad,
            };
          }),
        };
      })
      .filter(Boolean);

    res.status(200).json({ success: true, clientes });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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
    const accion = req.query && req.query.accion;
    if (req.method === 'GET' && accion === 'revisar-semana-siguiente') return await manejarRevisarSemanaSiguiente(req, res, sheets);
    if (req.method === 'GET' && accion === 'grid') return await manejarGrid(req, res, sheets);
    if (req.method === 'GET') return await manejarGet(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
