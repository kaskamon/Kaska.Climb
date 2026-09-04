const { google } = require('googleapis');

// Mismo Sheet que usa api/verificar-cliente.js (la base de alta de clientes,
// distinta del Sheet de sesiones).
const SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const SHEET_NAME = 'Respuestas de formulario 1';

// Columnas A-N del Sheet. M/N (fechaInicio/fechaFin) sustituyen a "duracion"
// como forma de llevar el contrato: el entrenador pone la fecha real de
// inicio (día 1 de entreno, no la de alta en el formulario) y una fecha de
// fin que va sumando a mano (+3 meses el trimestre inicial obligatorio,
// +1 mes en las renovaciones). La columna "duracion" (C) se queda en el
// Sheet pero ya no se usa ni se edita desde aquí.
const COL = {
  marcaTemporal: 0, estado: 1, duracion: 2, nombre: 3, apellidos: 4, telefono: 5,
  correo: 6, fechaNacimiento: 7, lesion: 8, modalidad: 9, disponibilidad: 10, drive: 11,
  fechaInicio: 12, fechaFin: 13,
};

// Campos que se pueden editar desde Clientes.html — Correo es el identificador
// real en toda la app (se usa como clave en todos los demás Sheets), así que
// deliberadamente no es editable aquí; Nombre/Apellidos tampoco, para no
// arriesgar una fila "huérfana" si alguna vez se usaran para emparejar algo.
const CAMPOS_EDITABLES = ['estado', 'telefono', 'fechaNacimiento', 'lesion', 'modalidad', 'disponibilidad', 'drive', 'fechaInicio', 'fechaFin'];

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

// GET — lista de clientes. Por defecto (como siempre): solo activos, 4 campos,
// para los desplegables de "Cliente" del resto de herramientas. Con
// ?completo=1: todos los clientes (activos e inactivos) con todas las
// columnas, para la tabla de gestión de Clientes.html.
async function manejarGet(req, res, sheets) {
  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:N`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la base de datos de clientes (${e.message}).`,
    });
  }

  const esCompleto = req.query && (req.query.completo === '1' || req.query.completo === 'true');

  if (!esCompleto) {
    const clientes = filas
      .filter(f => (f[COL.estado] || '').trim().toLowerCase() === 'activo' && (f[COL.correo] || '').trim())
      .map(f => {
        const nombre = (f[COL.nombre] || '').trim();
        const apellidos = (f[COL.apellidos] || '').trim();
        return {
          nombre,
          apellidos,
          nombreCompleto: [nombre, apellidos].filter(Boolean).join(' '),
          email: (f[COL.correo] || '').trim(),
        };
      })
      .sort((a, b) => a.nombreCompleto.localeCompare(b.nombreCompleto, 'es'));
    return res.status(200).json({ success: true, clientes });
  }

  const clientes = filas
    .slice(1) // saltamos la cabecera (su celda de correo no está vacía: "Correo electrónico")
    .filter(f => (f[COL.correo] || '').trim())
    .map(f => {
      const nombre = (f[COL.nombre] || '').trim();
      const apellidos = (f[COL.apellidos] || '').trim();
      return {
        nombre,
        apellidos,
        nombreCompleto: [nombre, apellidos].filter(Boolean).join(' '),
        email: (f[COL.correo] || '').trim(),
        estado: (f[COL.estado] || '').trim(),
        duracion: (f[COL.duracion] || '').trim(),
        telefono: (f[COL.telefono] || '').trim(),
        fechaNacimiento: (f[COL.fechaNacimiento] || '').trim(),
        lesion: (f[COL.lesion] || '').trim(),
        modalidad: (f[COL.modalidad] || '').trim(),
        disponibilidad: (f[COL.disponibilidad] || '').trim(),
        drive: (f[COL.drive] || '').trim(),
        marcaTemporal: (f[COL.marcaTemporal] || '').trim(),
        fechaInicio: (f[COL.fechaInicio] || '').trim(),
        fechaFin: (f[COL.fechaFin] || '').trim(),
      };
    })
    .sort((a, b) => a.nombreCompleto.localeCompare(b.nombreCompleto, 'es'));

  res.status(200).json({ success: true, clientes });
}

// POST — edita un cliente existente. Body: { correo, campos: { estado, duracion,
// telefono, fechaNacimiento, lesion, modalidad, disponibilidad, drive } } (solo
// hace falta incluir los campos que se quieran cambiar).
async function manejarPost(req, res, sheets) {
  const { correo, campos } = req.body || {};
  if (!correo || !campos || typeof campos !== 'object') {
    return res.status(400).json({ success: false, error: 'Faltan datos (correo o campos).' });
  }

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:N`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo leer la base de datos de clientes (${e.message}).` });
  }

  const correoBuscado = correo.trim().toLowerCase();
  const indiceFila = filas.findIndex(f => (f[COL.correo] || '').trim().toLowerCase() === correoBuscado);
  if (indiceFila === -1) {
    return res.status(404).json({ success: false, error: `No se encontró ningún cliente con el correo "${correo}".` });
  }
  const filaSheet = indiceFila + 1; // A1: fila 1 = índice 0

  const LETRA_COL = { estado: 'B', telefono: 'F', fechaNacimiento: 'H', lesion: 'I', modalidad: 'J', disponibilidad: 'K', drive: 'L', fechaInicio: 'M', fechaFin: 'N' };
  const data = CAMPOS_EDITABLES
    .filter(campo => Object.prototype.hasOwnProperty.call(campos, campo))
    .map(campo => ({
      range: `'${SHEET_NAME}'!${LETRA_COL[campo]}${filaSheet}`,
      values: [[campos[campo] === null || campos[campo] === undefined ? '' : String(campos[campo])]],
    }));

  if (!data.length) {
    return res.status(400).json({ success: false, error: 'No se ha indicado ningún campo editable a cambiar.' });
  }

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo actualizar el cliente (${e.message}).` });
  }

  res.status(200).json({ success: true, message: 'Cliente actualizado correctamente.' });
}

// POST (accion: 'alta') — alta de un cliente nuevo desde alta.html (público,
// sin contraseña — lo rellena el propio cliente). Body: { accion:'alta',
// nombre, apellidos, correo, telefono, fechaNacimiento, modalidad,
// disponibilidad, lesion }. Al aparecer la fila nueva en el Sheet, el Apps
// Script de altas (onChange) hace el resto solo: crea la carpeta de Drive y
// manda el correo de bienvenida — no hace falta tocar nada de eso aquí.
async function manejarAlta(req, res, sheets) {
  const { nombre, apellidos, correo, telefono, fechaNacimiento, modalidad, disponibilidad, lesion } = req.body || {};

  if (!nombre || !apellidos || !correo || !String(correo).includes('@')) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (nombre, apellidos o un correo válido).' });
  }

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:N`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo leer la base de datos de clientes (${e.message}).` });
  }

  const correoNuevo = correo.trim().toLowerCase();
  const yaExiste = filas.some(f => (f[COL.correo] || '').trim().toLowerCase() === correoNuevo);
  if (yaExiste) {
    return res.status(409).json({
      success: false,
      error: 'Ya existe una cuenta con ese correo. Si es un error, contacta directamente con tu entrenador.',
    });
  }

  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const disponibilidadTexto = Array.isArray(disponibilidad) ? disponibilidad.join(', ') : (disponibilidad || '');

  const fila = new Array(14).fill('');
  fila[COL.marcaTemporal] = marcaTemporal;
  fila[COL.estado] = 'Activo';
  fila[COL.nombre] = nombre;
  fila[COL.apellidos] = apellidos;
  fila[COL.telefono] = telefono || '';
  fila[COL.correo] = correo.trim();
  fila[COL.fechaNacimiento] = fechaNacimiento || '';
  fila[COL.lesion] = lesion || '';
  fila[COL.modalidad] = modalidad || '';
  fila[COL.disponibilidad] = disponibilidadTexto;

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:N`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo guardar el alta (${e.message}).` });
  }

  res.status(200).json({ success: true, message: 'Alta registrada correctamente.' });
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
    if (req.body && req.body.accion === 'alta') return await manejarAlta(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
