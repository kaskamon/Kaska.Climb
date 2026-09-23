const { driveComoEntrenador, clienteOAuth, SCOPES, GOOGLE_CLIENT_ID, obtenerAccessTokenEntrenador, explicarErrorOAuth } = require('../libs/google-oauth-entrenador.js');
const { verificarEntrenador } = require('../libs/sesion-cliente.js');
const { authSheets: authSheetsCacheado, SCOPE_LECTURA_ESCRITURA } = require('../libs/sheets-auth.js');
const { sanearFormula } = require('../libs/sheets-sanitize.js');
const { parseFechaDDMMYYYY } = require('../libs/planificacion-semanas.js');
const {
  CORREO_ENTRENADOR,
  enviarCorreoComoEntrenador,
  avisarFalloTareaProgramada,
  registrarEstadoTarea,
  exigirEntrenador,
  exigirEntrenadorOCron,
} = require('../libs/entrenador-notificaciones.js');

// Mismo Sheet que usa api/verificar-cliente.js (la base de alta de clientes,
// distinta del Sheet de sesiones).
const SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const SHEET_NAME = 'Respuestas de formulario 1';

// Límite de intentos fallidos del código de acceso del alta pública — un
// contador simple en memoria por IP y por instancia caliente. No es un
// rate-limit distribuido perfecto (se resetea en un arranque en frío, y cada
// instancia concurrente tiene su propio contador), pero corta de raíz la
// fuerza bruta trivial sin fricción que existía antes, que es el riesgo real
// en un endpoint público protegido solo por una contraseña compartida.
const intentosFallidosAlta = new Map();
const VENTANA_INTENTOS_MS = 10 * 60 * 1000; // 10 minutos
const MAX_INTENTOS_FALLIDOS = 5;

function demasiadosIntentosAlta(ip) {
  const registro = intentosFallidosAlta.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.desde > VENTANA_INTENTOS_MS) {
    intentosFallidosAlta.delete(ip);
    return false;
  }
  return registro.cuenta >= MAX_INTENTOS_FALLIDOS;
}
function registrarIntentoFallidoAlta(ip) {
  const ahora = Date.now();
  const registro = intentosFallidosAlta.get(ip);
  if (!registro || ahora - registro.desde > VENTANA_INTENTOS_MS) {
    intentosFallidosAlta.set(ip, { cuenta: 1, desde: ahora });
  } else {
    registro.cuenta++;
  }
}

// Columnas A-N del Sheet. M/N (fechaInicio/fechaFin) sustituyen a "duracion"
// como forma de llevar el contrato: el entrenador pone la fecha real de
// inicio (día 1 de entreno, no la de alta en el formulario) y una fecha de
// fin que va sumando a mano (+3 meses el trimestre inicial obligatorio,
// +1 mes en las renovaciones). La columna "duracion" (C) se queda en el
// Sheet pero ya no se usa ni se edita desde aquí.
const COL = {
  marcaTemporal: 0, estado: 1, duracion: 2, nombre: 3, apellidos: 4, telefono: 5,
  correo: 6, fechaNacimiento: 7, lesion: 8, modalidad: 9, disponibilidad: 10, drive: 11,
  fechaInicio: 12, fechaFin: 13, condicionesAceptadas: 14,
};

// Defensa mínima contra una columna reordenada o insertada a mano en el
// Sheet (el entrenador ya edita cosas ahí directamente, como fechaFin): si
// la cabecera de la columna de correo (G, índice 6 — el identificador real
// del cliente en toda la app) deja de contener "correo", es señal de que las
// columnas ya no están donde el resto del código asume. Mejor fallar aquí
// con un aviso claro que seguir leyendo/escribiendo silenciosamente datos de
// un cliente en la fila de otro. Devuelve un mensaje de error, o null si la
// cabecera está donde debería.
function errorCabeceraClientes(filas) {
  const cabecera = (filas[0] && filas[0][COL.correo]) || '';
  if (!cabecera.toLowerCase().includes('correo')) {
    return `La columna de correo del Sheet de clientes no tiene la cabecera esperada (dice "${cabecera}") — puede que se haya movido alguna columna. Revísalo en el Sheet antes de seguir.`;
  }
  return null;
}

// Campos que se pueden editar desde Clientes.html — Correo es el identificador
// real en toda la app (se usa como clave en todos los demás Sheets), así que
// deliberadamente no es editable aquí; Nombre/Apellidos tampoco, para no
// arriesgar una fila "huérfana" si alguna vez se usaran para emparejar algo.
const CAMPOS_EDITABLES = ['estado', 'telefono', 'fechaNacimiento', 'lesion', 'modalidad', 'disponibilidad', 'drive', 'fechaInicio', 'fechaFin'];

// Carpeta padre en Drive donde vive la carpeta de cada cliente. La carpeta de
// cada cliente se crea con la cuenta de Google del propio entrenador (ver
// libs/google-oauth-entrenador.js), no con la cuenta de servicio: una cuenta
// de servicio no puede transferir la propiedad de un archivo a una cuenta de
// Gmail normal por API (Google lo bloquea desde 2022), así que la única forma
// de que la carpeta nazca ya siendo del entrenador es crearla directamente
// como él.
const DRIVE_PARENT_ID = '16Ef_byfR5qhWQgn5YvEej3Nem8uGljBO';

function authSheets() {
  return authSheetsCacheado(SCOPE_LECTURA_ESCRITURA);
}

// GET — lista de clientes. Por defecto (como siempre): solo activos, 4 campos,
// para los desplegables de "Cliente" del resto de herramientas. Con
// ?completo=1: todos los clientes (activos e inactivos) con todas las
// columnas, para la tabla de gestión de Clientes.html.
async function manejarGet(req, res, sheets) {
  // Lista completa de clientes (nombre, teléfono, ¿lesión?, fecha de
  // nacimiento, enlace a su carpeta de Drive...) — solo el entrenador, nunca
  // público. El alta de un cliente nuevo (accion:'alta') es una rama
  // distinta del router, con su propia contraseña (ALTA_PASSWORD), no pasa
  // por aquí.
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:O`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `No se pudo leer la base de datos de clientes (${e.message}).`,
    });
  }
  const errorCab = errorCabeceraClientes(filas);
  if (errorCab) return res.status(500).json({ success: false, error: errorCab });

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
        condicionesAceptadas: (f[COL.condicionesAceptadas] || '').trim(),
      };
    })
    .sort((a, b) => a.nombreCompleto.localeCompare(b.nombreCompleto, 'es'));

  res.status(200).json({ success: true, clientes });
}

// POST — edita un cliente existente. Body: { correo, campos: { estado, duracion,
// telefono, fechaNacimiento, lesion, modalidad, disponibilidad, drive } } (solo
// hace falta incluir los campos que se quieran cambiar).
async function manejarPost(req, res, sheets) {
  // Editar un cliente ya existente (incluido su estado Activo/Inactivo) —
  // solo el entrenador.
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }

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
  const errorCabPost = errorCabeceraClientes(filas);
  if (errorCabPost) return res.status(500).json({ success: false, error: errorCabPost });

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
      values: [[sanearFormula(campos[campo] === null || campos[campo] === undefined ? '' : String(campos[campo]))]],
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

// POST (accion: 'eliminar') — borra por completo la fila de un cliente
// (limpieza de datos de prueba, altas erróneas...). Body: { accion:'eliminar', correo }.
async function manejarEliminar(req, res, sheets) {
  // Borra la fila de un cliente por completo — solo el entrenador, y de
  // forma irreversible, así que el guardián va lo primero de todo.
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }

  const { correo } = req.body || {};
  if (!correo) {
    return res.status(400).json({ success: false, error: 'Falta el correo del cliente a eliminar.' });
  }

  let meta, resp;
  try {
    [meta, resp] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:N` }),
    ]);
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo leer la base de datos de clientes (${e.message}).` });
  }

  const correoBuscado = correo.trim().toLowerCase();
  const filas = resp.data.values || [];
  const errorCabElim = errorCabeceraClientes(filas);
  if (errorCabElim) return res.status(500).json({ success: false, error: errorCabElim });
  const indiceFila = filas.findIndex(f => (f[COL.correo] || '').trim().toLowerCase() === correoBuscado);
  if (indiceFila === -1) {
    return res.status(404).json({ success: false, error: `No se encontró ningún cliente con el correo "${correo}".` });
  }

  const hoja = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  if (!hoja) {
    return res.status(500).json({ success: false, error: `No se encontró la pestaña "${SHEET_NAME}".` });
  }

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId: hoja.properties.sheetId, dimension: 'ROWS', startIndex: indiceFila, endIndex: indiceFila + 1 },
          },
        }],
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo eliminar el cliente (${e.message}).` });
  }

  res.status(200).json({ success: true, message: 'Cliente eliminado correctamente.' });
}

// GET ?accion=estado-sistema — última ejecución conocida de cada tarea
// programada (ver registrarEstadoTarea en libs/entrenador-notificaciones.js).
// Lo consulta Clientes.html al cargar para avisar si algo se quedó sin
// completar. Si la pestaña "Estado_Sistema" todavía no existe (recién
// desplegado, nadie la ha creado a mano aún) no es un error — simplemente no
// hay nada que avisar todavía.
async function manejarEstadoSistema(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) {
    return res.status(401).json({ success: false, error: acceso.error });
  }
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Estado_Sistema'!A:D`,
    });
    // slice(1): la fila 1 es la cabecera ("Tarea", "OK", "Mensaje", "Fecha")
    // que registrarEstadoTarea escribe al crear la pestaña — sin saltarla se
    // colaba como si fuera una tarea real llamada "Tarea" con ok:false
    // (porque "OK" no es "sí"), mostrando siempre el aviso "Tarea no se
    // completó (Fecha): Mensaje." aunque todas las tareas reales hubiesen
    // ido bien.
    const tareas = (resp.data.values || []).slice(1).map(f => ({
      tarea: (f[0] || '').trim(),
      ok: ['sí', 'si'].includes((f[1] || '').trim().toLowerCase()),
      mensaje: (f[2] || '').trim(),
      fecha: (f[3] || '').trim(),
    })).filter(t => t.tarea);
    res.status(200).json({ success: true, tareas });
  } catch (e) {
    res.status(200).json({ success: true, tareas: [] });
  }
}

const SHEET_NOTIF_LEIDAS = 'Notificaciones_Leidas';

// GET ?accion=notif-leidas — claves de notificaciones ya marcadas como
// leídas por el entrenador. Antes este estado vivía solo en localStorage
// (Seguimiento.html), así que un aviso marcado leído en el PC seguía
// saliendo como nuevo en el móvil o la tablet — con esto queda
// sincronizado entre dispositivos, en su propia pestaña porque no tiene
// relación con los datos de clientes.
async function manejarNotifLeidasGet(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NOTIF_LEIDAS}'!A:A`,
    });
    const claves = (resp.data.values || []).map(f => (f[0] || '').trim()).filter(Boolean);
    res.status(200).json({ success: true, claves });
  } catch (e) {
    res.status(200).json({ success: true, claves: [] });
  }
}

// POST ?accion=marcar-notif-leida {clave, vigentes:[...]} — añade `clave` a
// las leídas y, de paso, descarta cualquier clave guardada que ya no esté
// en `vigentes` (las notificaciones que el entrenador tiene delante ahora
// mismo). Mismo criterio de poda que antes hacía guardarLeidas() en
// localStorage: sin esto, la pestaña solo crecería, y un cliente que
// vuelve a caducar más adelante (misma clave "inactivo|correo" de antes)
// se quedaría marcado leído para siempre por error. Reescribe la pestaña
// entera de golpe en vez de buscar/actualizar una fila — la lista es
// siempre pequeña (unas pocas decenas de claves como mucho).
async function manejarMarcarNotifLeida(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });
  const clave = ((req.body && req.body.clave) || '').toString().trim();
  if (!clave) return res.status(400).json({ success: false, error: 'Falta el parámetro clave.' });
  // Sin lista de vigentes (el panel no pudo cargar todas las fuentes de
  // notificaciones) no se poda nada: una lista parcial haría "olvidar" como
  // no leídas notificaciones que sí siguen vigentes.
  const vigentes = Array.isArray(req.body.vigentes) ? new Set(req.body.vigentes.map(String)) : null;

  try {
    let filas;
    try {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NOTIF_LEIDAS}'!A:A` });
      filas = resp.data.values || [];
    } catch (e) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NOTIF_LEIDAS } } }] },
      });
      filas = [];
    }

    const existentes = filas.map(f => (f[0] || '').trim()).filter(Boolean);
    const podadas = vigentes ? existentes.filter(c => vigentes.has(c)) : existentes.slice();
    if (!podadas.includes(clave)) podadas.push(clave);

    // Primero se escribe la lista nueva y después se limpian las filas que
    // sobran por debajo — al revés (clear + update) un fallo entre las dos
    // llamadas dejaba la pestaña vacía, y TODAS las notificaciones volvían a
    // salir como no leídas.
    const fecha = new Date().toISOString();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NOTIF_LEIDAS}'!A1:B${podadas.length}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: podadas.map(c => [sanearFormula(c), fecha]) },
    });
    if (filas.length > podadas.length) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SHEET_NOTIF_LEIDAS}'!A${podadas.length + 1}:B${filas.length}`,
      });
    }
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// GET ?accion=sincronizar-fecha-inicio — migración de UNA SOLA VEZ: ahora
// que la fecha de inicio del contrato se fija automáticamente al publicar
// la Batería de test (ver api/bateria-test.js) en vez de al publicar la
// primera sesión real, esta acción recalcula fechaInicio Y fechaFin (=
// fechaInicio+3 meses) de los clientes que YA tenían esas fechas puestas
// con el criterio antiguo, usando la fecha real (más antigua, si hay
// varias) de su Batería de test. Sobrescribe ambas para cualquier cliente
// con batería registrada, aunque ya tuvieran una renovación puesta a mano
// (decisión explícita: el botón "+1 mes"/"+3 meses" de Clientes.html sigue
// ahí tal cual para volver a prorrogar después de esto). No hay botón para
// esto en ninguna página — se visita esta URL una vez, a mano, con la
// contraseña de entrenador, y no pasa nada si se repite (es idempotente: si
// ya coincide, no se reescribe).
async function manejarSincronizarFechaInicio(req, res, sheets) {
  // exigirEntrenador (no verificarEntrenador): esta acción se visita
  // directamente pegando la URL, sin pasar antes por ninguna página ya
  // autenticada — hace falta el popup nativo (cabecera WWW-Authenticate)
  // para que el navegador pida la contraseña. verificarEntrenador (lo que
  // había aquí) solo devuelve un 401 en JSON sin pedir nada, así que sin
  // credenciales de Basic Auth ya cacheadas de antes en ese navegador, la
  // migración siempre fallaba en silencio con "solo para el entrenador".
  if (!exigirEntrenador(req, res)) return;

  let filasBateria;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID_SESIONES,
      range: `'Bateria_Test'!A:D`,
    });
    filasBateria = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo leer "Bateria_Test" (${e.message}).` });
  }

  // Fecha más antigua (g-fecha, "aaaa-mm-dd" — ordena bien como texto) por
  // correo — varias baterías del mismo cliente cuentan como su fecha real
  // de inicio la de la PRIMERA que se le hizo.
  const primeraFechaPorCorreo = new Map();
  filasBateria.forEach(f => {
    const correo = (f[1] || '').trim().toLowerCase();
    const fecha = (f[3] || '').trim();
    if (!correo || !fecha) return;
    const actual = primeraFechaPorCorreo.get(correo);
    if (!actual || fecha < actual) primeraFechaPorCorreo.set(correo, fecha);
  });

  let filasClientes;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:N`,
    });
    filasClientes = resp.data.values || [];
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo leer la base de datos de clientes (${e.message}).` });
  }
  const errorCab = errorCabeceraClientes(filasClientes);
  if (errorCab) return res.status(500).json({ success: false, error: errorCab });

  const aFecha = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const formatear = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

  const cambios = [];
  const data = [];
  filasClientes.forEach((f, i) => {
    if (i === 0) return; // cabecera
    const correo = (f[COL.correo] || '').trim().toLowerCase();
    if (!correo) return;
    const fechaBateriaISO = primeraFechaPorCorreo.get(correo);
    if (!fechaBateriaISO) return; // sin batería registrada, no se toca

    const inicio = aFecha(fechaBateriaISO);
    const fin = new Date(inicio);
    fin.setMonth(fin.getMonth() + 3);
    const nuevoInicio = formatear(inicio);
    const nuevoFin = formatear(fin);
    const actualInicio = (f[COL.fechaInicio] || '').trim();
    const actualFin = (f[COL.fechaFin] || '').trim();
    if (actualInicio === nuevoInicio && actualFin === nuevoFin) return; // ya coincide, nada que hacer

    cambios.push({
      correo,
      inicio: { antes: actualInicio || '(vacío)', despues: nuevoInicio },
      fin: { antes: actualFin || '(vacío)', despues: nuevoFin },
    });
    data.push(
      { range: `'${SHEET_NAME}'!M${i + 1}`, values: [[sanearFormula(nuevoInicio)]] },
      { range: `'${SHEET_NAME}'!N${i + 1}`, values: [[sanearFormula(nuevoFin)]] },
    );
  });

  if (data.length) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: `No se pudo escribir la actualización (${e.message}).`, cambiosPrevistos: cambios });
    }
  }

  res.status(200).json({ success: true, actualizados: cambios.length, cambios });
}

// GET ?accion=revisar-caducados — pasa a Inactivo a los clientes Activos cuya
// fecha de fin ya venció, y avisa por correo si ha marcado alguno. La
// dispara sola vercel.json cada día, con el CRON_SECRET que manda Vercel
// automáticamente — ya no hay botón manual, solo el cron.
async function manejarRevisarCaducados(req, res, sheets) {
  if (!exigirEntrenadorOCron(req, res)) return;

  let filas;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:N`,
    });
    filas = resp.data.values || [];
  } catch (e) {
    await avisarFalloTareaProgramada('Revisión de caducados', e.message);
    await registrarEstadoTarea(sheets, SPREADSHEET_ID, 'Revisión de caducados', false, e.message);
    return res.status(500).json({ success: false, error: `No se pudo leer la base de datos de clientes (${e.message}).` });
  }
  const errorCabCad = errorCabeceraClientes(filas);
  if (errorCabCad) {
    await avisarFalloTareaProgramada('Revisión de caducados', errorCabCad);
    await registrarEstadoTarea(sheets, SPREADSHEET_ID, 'Revisión de caducados', false, errorCabCad);
    return res.status(500).json({ success: false, error: errorCabCad });
  }

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const caducados = [];

  filas.forEach((f, i) => {
    if (i === 0) return; // cabecera
    if ((f[COL.estado] || '').trim().toLowerCase() !== 'activo') return;
    const fin = parseFechaDDMMYYYY(f[COL.fechaFin]);
    if (!fin || fin >= hoy) return;
    const nombre = (f[COL.nombre] || '').trim();
    const apellidos = (f[COL.apellidos] || '').trim();
    caducados.push({
      filaSheet: i + 1, // A1: fila 1 = índice 0
      nombreCompleto: [nombre, apellidos].filter(Boolean).join(' '),
      correo: (f[COL.correo] || '').trim(),
      fechaFin: (f[COL.fechaFin] || '').trim(),
    });
  });

  if (caducados.length) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: caducados.map(c => ({ range: `'${SHEET_NAME}'!B${c.filaSheet}`, values: [['Inactivo']] })),
        },
      });
    } catch (e) {
      await avisarFalloTareaProgramada('Revisión de caducados', e.message);
      await registrarEstadoTarea(sheets, SPREADSHEET_ID, 'Revisión de caducados', false, e.message);
      return res.status(500).json({ success: false, error: `No se pudo actualizar los clientes caducados (${e.message}).` });
    }

    try {
      const plural = caducados.length === 1 ? '' : 's';
      const asunto = `${caducados.length} cliente${plural} pasado${plural} a Inactivo por caducidad`;
      const cuerpo = [
        `Se ${caducados.length === 1 ? 'ha' : 'han'} marcado Inactivo automáticamente por haber pasado su fecha de fin:`,
        ``,
        ...caducados.map(c => `- ${c.nombreCompleto} (${c.correo}) — fin: ${c.fechaFin}`),
        ``,
        `Revísalo en Clientes.html si alguno necesita renovarse en vez de quedar inactivo.`,
      ].join('\r\n');
      await enviarCorreoComoEntrenador(CORREO_ENTRENADOR, asunto, cuerpo);
    } catch (e) {
      console.error(`No se pudo mandar el aviso de clientes caducados: ${e.message}`);
    }
  }

  await registrarEstadoTarea(sheets, SPREADSHEET_ID, 'Revisión de caducados', true, '');
  res.status(200).json({ success: true, marcados: caducados.length });
}

// Copia entera del Sheet indicado a la carpeta de backups, y borra las copias
// más antiguas por encima de BACKUP_RETENCION (busca por nombre dentro de esa
// carpeta — cada tipo tiene su propio prefijo, así que no se mezclan entre sí).
const BACKUP_RETENCION = 7;

async function copiarConRetencion(drive, carpetaId, spreadsheetId, prefijoNombre) {
  const fechaStr = new Date().toISOString().slice(0, 10);
  await drive.files.copy({
    fileId: spreadsheetId,
    requestBody: { name: `${prefijoNombre} ${fechaStr}`, parents: [carpetaId] },
  });

  const listado = await drive.files.list({
    q: `'${carpetaId}' in parents and name contains '${prefijoNombre.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime desc',
  });
  const sobrantes = (listado.data.files || []).slice(BACKUP_RETENCION);
  for (const f of sobrantes) {
    try {
      await drive.files.delete({ fileId: f.id });
    } catch (e) {
      console.error(`No se pudo borrar la copia de seguridad antigua "${f.name}": ${e.message}`);
    }
  }
}

// Carpeta propia del entrenador (no DRIVE_PARENT_ID, que es la de clientes) —
// se busca/crea en la raíz de su Drive la primera vez que hace falta.
const BACKUP_FOLDER_NOMBRE = 'Kaska.Climb — Copias de seguridad diarias';

async function asegurarCarpetaBackups(drive) {
  const nombreEscapado = BACKUP_FOLDER_NOMBRE.replace(/'/g, "\\'");
  const resp = await drive.files.list({
    q: `name = '${nombreEscapado}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`,
    fields: 'files(id)',
  });
  if (resp.data.files && resp.data.files[0]) return resp.data.files[0].id;
  const nueva = await drive.files.create({
    requestBody: { name: BACKUP_FOLDER_NOMBRE, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return nueva.data.id;
}

// El otro Sheet de la app (sesiones, batería test, macrociclos...) — SPREADSHEET_ID
// en este archivo es el de clientes, así que hace falta el segundo ID aparte.
const SPREADSHEET_ID_SESIONES = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';

// GET ?accion=backup-diario — copia completa e independiente de los dos
// Sheets de la app (sesiones y clientes) a una carpeta de Drive del propio
// entrenador, con las últimas BACKUP_RETENCION copias de cada uno. A
// diferencia del historial de versiones de Google (que desaparece si se
// borra el archivo original y se vacía la papelera), esto es un archivo
// aparte de verdad. Se dispara sola cada día (ver vercel.json, con el
// CRON_SECRET que manda Vercel automáticamente) o a mano con la contraseña
// de entrenador.
async function manejarBackupDiario(req, res) {
  if (!exigirEntrenadorOCron(req, res)) return;

  try {
    const drive = driveComoEntrenador();
    const carpetaId = await asegurarCarpetaBackups(drive);
    await copiarConRetencion(drive, carpetaId, SPREADSHEET_ID_SESIONES, 'Kaska.Climb (sesiones)');
    await copiarConRetencion(drive, carpetaId, SPREADSHEET_ID, 'Kaska.Climb (clientes)');
    await registrarEstadoTarea(await authSheets(), SPREADSHEET_ID, 'Copia de seguridad diaria', true, '');
    res.status(200).json({ success: true, message: 'Copia de seguridad diaria completada.' });
  } catch (e) {
    const mensaje = explicarErrorOAuth(e.message);
    await avisarFalloTareaProgramada('Copia de seguridad diaria', mensaje);
    // registrarEstadoTarea solo usa la cuenta de servicio (siempre más fiable
    // que el OAuth del entrenador, que es justo lo que puede haber fallado
    // arriba) — así este aviso sigue quedando escrito aunque el correo, el
    // propio Drive, o el token OAuth estén rotos.
    await registrarEstadoTarea(await authSheets(), SPREADSHEET_ID, 'Copia de seguridad diaria', false, mensaje);
    res.status(500).json({ success: false, error: mensaje });
  }
}

// Busca una carpeta por nombre exacto dentro de otra (evita duplicados si se
// reprocesa el mismo cliente), igual que getFoldersByName() del script viejo.
async function buscarCarpetaPorNombre(drive, nombre, idPadre) {
  const nombreEscapado = nombre.replace(/'/g, "\\'");
  const resp = await drive.files.list({
    q: `'${idPadre}' in parents and name = '${nombreEscapado}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
  });
  return resp.data.files && resp.data.files[0] ? resp.data.files[0].id : null;
}

// Crea la carpeta del cliente dentro de DRIVE_PARENT_ID (con la cuenta de
// Google del propio entrenador, ver libs/google-oauth-entrenador.js) y la
// comparte con él como lector. Devuelve su enlace. Best-effort: si falla
// (p.ej. todavía no se ha completado el alta de ?accion=drive-oauth-inicio),
// el alta del cliente ya se ha guardado igualmente — se registra el error en
// los logs y el entrenador puede rellenar el enlace a mano desde Clientes.html.
async function crearCarpetaCliente(nombreCompleto, correoCliente) {
  const drive = driveComoEntrenador();

  let carpetaId = await buscarCarpetaPorNombre(drive, nombreCompleto, DRIVE_PARENT_ID);
  let esNueva = false;
  if (!carpetaId) {
    esNueva = true;
    const nueva = await drive.files.create({
      requestBody: { name: nombreCompleto, mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_PARENT_ID] },
      fields: 'id',
    });
    carpetaId = nueva.data.id;
  }

  if (esNueva && correoCliente) {
    try {
      await drive.permissions.create({
        fileId: carpetaId,
        requestBody: { role: 'reader', type: 'user', emailAddress: correoCliente },
      });
    } catch (e) {
      console.error(`No se pudo compartir la carpeta con ${correoCliente}: ${e.message}`);
    }
  }

  return `https://drive.google.com/drive/folders/${carpetaId}`;
}

// Correo de bienvenida al cliente — mismo texto que ya teníais probado en el
// script de Apps Script, incluidas las instrucciones para instalarla como PWA.
async function enviarBienvenidaCliente(correoCliente, nombreCliente, urlCarpeta) {
  const asunto = 'Bienvenido/a al entrenamiento personalizado Kaska.Climb';
  const cuerpo = [
    `Hola ${nombreCliente},`,
    ``,
    `¡Qué bueno tenerte a bordo! Ya he preparado tu base de datos para comenzar con los entrenamientos.`,
    ``,
    `A partir de ahora, podrás acceder a tu zona personal desde cualquier dispositivo, accediendo a este enlace: https://kaska-climb.vercel.app/login.html e iniciando sesión con tu cuenta de Google.`,
    ``,
    `Truco: puedes instalarla en tu móvil como si fuera una app normal, sin pasar por la App Store ni Google Play. Entra en el enlace desde el navegador y:`,
    `- iPhone (Safari): pulsa el botón de compartir (el cuadrado con la flecha hacia arriba) y elige "Añadir a pantalla de inicio".`,
    `- Android (Chrome): pulsa el menú (los tres puntos, arriba a la derecha) y elige "Instalar aplicación" o "Añadir a pantalla de inicio".`,
    ``,
    `Te queda un icono como cualquier otra app, y se abre a pantalla completa, más rápido y sin la barra del navegador.`,
    ``,
    `Además, ya tienes lista tu carpeta personal en la nube por si en algún momento necesito compartirte vídeos o imágenes: ${urlCarpeta || '(la comparto en breve)'}`,
    ``,
    `¡Vamos a por tus objetivos!`,
  ].join('\r\n');
  await enviarCorreoComoEntrenador(correoCliente, asunto, cuerpo);
}

// Manda el aviso de "cliente nuevo" a CORREO_ENTRENADOR. Best-effort, igual
// que las dos funciones de arriba — si falla no bloquea el alta.
async function enviarAvisoNuevoCliente(datos) {
  const asunto = `Nuevo cliente registrado: ${datos.nombreCompleto}`;
  const cuerpo = [
    `Un nuevo cliente ha completado el formulario de alta:`,
    ``,
    `Nombre: ${datos.nombreCompleto}`,
    `Correo: ${datos.correo}`,
    `Teléfono: ${datos.telefono || '—'}`,
    `Fecha de nacimiento: ${datos.fechaNacimiento || '—'}`,
    `Modalidad: ${datos.modalidad || '—'}`,
    `Disponibilidad: ${datos.disponibilidad || '—'}`,
    `¿Lesión?: ${datos.lesion || '—'}`,
    `Enlace a su carpeta de Drive: ${datos.urlCarpeta || '(no se pudo crear, revísalo en Clientes.html)'}`,
    ``,
    datos.bienvenidaEnviada
      ? 'El correo de bienvenida ya ha sido enviado automáticamente al cliente.'
      : 'OJO: no se ha podido mandar el correo de bienvenida al cliente — revisa los logs de Vercel.',
  ].join('\r\n');
  await enviarCorreoComoEntrenador(CORREO_ENTRENADOR, asunto, cuerpo);
}

// POST (accion: 'alta') — alta de un cliente nuevo desde alta.html (público,
// pero con un código de acceso compartido — se lo da el entrenador a mano al
// cliente nuevo, para que nadie pueda rellenarlo sin más y crear altas falsas,
// carpetas de Drive de mentira o correos de "bienvenida" a cualquiera).
// Body: { accion:'alta', codigoAcceso, nombre, apellidos, correo, telefono,
// fechaNacimiento, modalidad, disponibilidad, lesion }. La carpeta de Drive
// se crea aquí mismo (ver crearCarpetaCliente) — antes lo hacía un Apps
// Script vinculado al Sheet con un disparador "al enviarse el formulario",
// pero ese disparador nunca ve las altas que llegan por esta API (no son un
// envío real del Google Form), así que la carpeta se dejaba de crear en silencio.
async function manejarAlta(req, res, sheets) {
  const { codigoAcceso, nombre, apellidos, correo, telefono, fechaNacimiento, modalidad, disponibilidad, lesion, aceptaCondiciones } = req.body || {};

  if (!process.env.ALTA_PASSWORD) {
    return res.status(500).json({ success: false, error: 'Falta configurar ALTA_PASSWORD en Vercel.' });
  }
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || 'desconocida';
  if (demasiadosIntentosAlta(ip)) {
    return res.status(429).json({ success: false, error: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a intentarlo.' });
  }
  if (!codigoAcceso || codigoAcceso !== process.env.ALTA_PASSWORD) {
    registrarIntentoFallidoAlta(ip);
    return res.status(401).json({ success: false, error: 'Código de acceso incorrecto — pídeselo a tu entrenador.' });
  }
  // Mismo patrón que alta.html en el navegador — ahí solo protege de que el
  // cliente se equivoque al escribir; aquí, al ser la comprobación real del
  // servidor, además evita que un correo con espacios o saltos de línea
  // (\r\n) acabe colándose como identificador del cliente o en la cabecera
  // "To:" de sus correos.
  if (!nombre || !apellidos || !correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(correo))) {
    return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (nombre, apellidos o un correo válido).' });
  }
  // Igual que arriba: el checkbox de alta.html ya bloquea el envío en el
  // navegador, pero la comprobación que de verdad vale como evidencia de que
  // se aceptó es esta, no la del cliente.
  if (aceptaCondiciones !== true) {
    return res.status(400).json({ success: false, error: 'Tienes que aceptar la política de privacidad y el aviso de responsabilidad para darte de alta.' });
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
  const errorCabAlta = errorCabeceraClientes(filas);
  if (errorCabAlta) return res.status(500).json({ success: false, error: errorCabAlta });

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

  const fila = new Array(15).fill('');
  fila[COL.marcaTemporal] = marcaTemporal;
  fila[COL.estado] = 'Activo';
  fila[COL.nombre] = sanearFormula(nombre);
  fila[COL.apellidos] = sanearFormula(apellidos);
  fila[COL.telefono] = sanearFormula(telefono || '');
  fila[COL.correo] = sanearFormula(correo.trim());
  fila[COL.fechaNacimiento] = sanearFormula(fechaNacimiento || '');
  fila[COL.lesion] = sanearFormula(lesion || '');
  fila[COL.modalidad] = sanearFormula(modalidad || '');
  fila[COL.disponibilidad] = sanearFormula(disponibilidadTexto);
  // Evidencia de consentimiento: la fecha es la misma que marcaTemporal (el
  // checkbox es obligatorio para llegar hasta aquí, así que el alta y la
  // aceptación ocurren en el mismo instante) — basta con dejar constancia de
  // que se aceptó, sin duplicar la fecha en otra columna.
  fila[COL.condicionesAceptadas] = 'Sí';

  // Escribimos en la fila exacta que le toca (ya sabemos cuántas filas reales
  // hay por el values.get de arriba) en vez de usar values.append: este Sheet
  // nació como respuestas de un Google Form, y algún resto de contenido muy
  // abajo (aunque se vea vacío) hace que el auto-detectado de tabla de
  // append() se equivoque y añada al final físico del Sheet (fila 1005, en
  // vez de justo debajo del último cliente real).
  const filaInsertada = filas.length + 1;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A${filaInsertada}:O${filaInsertada}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [fila] },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: `No se pudo guardar el alta (${e.message}).` });
  }

  const nombreCompleto = [nombre, apellidos].filter(Boolean).join(' ');
  const correoLimpio = correo.trim();
  let urlCarpeta = '';
  let bienvenidaEnviada = false;

  try {
    urlCarpeta = await crearCarpetaCliente(nombreCompleto, correoLimpio);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!L${filaInsertada}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[urlCarpeta]] },
    });
  } catch (e) {
    // El alta ya está guardada — no se bloquea al cliente por esto. Queda
    // en los logs de Vercel para que el entrenador lo rellene a mano si hace falta.
    console.error(`No se pudo crear la carpeta de Drive para ${correo}: ${e.message}`);
  }

  try {
    await enviarBienvenidaCliente(correoLimpio, nombre, urlCarpeta);
    bienvenidaEnviada = true;
  } catch (e) {
    console.error(`No se pudo mandar el correo de bienvenida a ${correo}: ${e.message}`);
  }

  try {
    await enviarAvisoNuevoCliente({ nombreCompleto, correo: correoLimpio, urlCarpeta, bienvenidaEnviada, telefono, fechaNacimiento, modalidad, disponibilidad: disponibilidadTexto, lesion });
  } catch (e) {
    console.error(`No se pudo mandar el aviso de cliente nuevo para ${correo}: ${e.message}`);
  }

  res.status(200).json({ success: true, message: 'Alta registrada correctamente.' });
}

function paginaResultado(titulo, cuerpoHtml) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>${titulo} · Kaska.Climb</title>
<style>
  body{ font-family:'Work Sans',-apple-system,sans-serif; max-width:640px; margin:60px auto; padding:0 24px; color:#1c211e; line-height:1.6; }
  h1{ font-size:20px; } code, textarea{ font-family:ui-monospace,Consolas,monospace; }
  textarea{ width:100%; min-height:90px; padding:10px; border-radius:8px; border:1px solid #ccc; font-size:13px; }
  ol{ padding-left:20px; } li{ margin-bottom:8px; }
  .aviso{ background:#fdeeea; border:1px solid #e0a596; padding:12px 16px; border-radius:8px; }
</style></head><body>${cuerpoHtml}</body></html>`;
}

// GET ?accion=drive-oauth-inicio — paso 1 del alta de Drive del entrenador
// (un solo uso, ver libs/google-oauth-entrenador.js): redirige a la pantalla
// de consentimiento de Google. access_type=offline+prompt=consent para que
// Google mande el refresh_token también si ya se había dado acceso antes.
async function manejarDriveOAuthInicio(req, res) {
  if (!exigirEntrenador(req, res)) return;
  if (!process.env.GOOGLE_CLIENT_SECRET) {
    res.status(500).send('Falta GOOGLE_CLIENT_SECRET en Vercel — cópialo desde Google Cloud Console → APIs y servicios → Credenciales → tu Client ID → Client Secret, y añádelo antes de continuar.');
    return;
  }
  const url = clienteOAuth().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.writeHead(302, { Location: url });
  res.end();
}

// GET ?accion=drive-oauth-callback — paso 2: Google vuelve aquí con un
// "code". Lo cambiamos por los tokens reales y mostramos el refresh_token en
// pantalla para copiarlo a mano a GOOGLE_TRAINER_REFRESH_TOKEN en Vercel — no
// hay ningún sitio donde guardarlo solo desde el backend.
async function manejarDriveOAuthCallback(req, res) {
  if (!exigirEntrenador(req, res)) return;
  const { code, error } = req.query || {};

  if (error) {
    res.status(400).send(paginaResultado('Cancelado', `<h1>Consentimiento cancelado</h1><p>Google devolvió: <code>${error}</code>. Vuelve a intentarlo desde ?accion=drive-oauth-inicio.</p>`));
    return;
  }
  if (!code) {
    res.status(400).send(paginaResultado('Falta el código', '<h1>Falta el parámetro "code"</h1><p>Entra por ?accion=drive-oauth-inicio, no directamente aquí.</p>'));
    return;
  }
  if (!process.env.GOOGLE_CLIENT_SECRET) {
    res.status(500).send(paginaResultado('Falta configuración', '<h1>Falta GOOGLE_CLIENT_SECRET en Vercel</h1><p>Cópialo desde Google Cloud Console → APIs y servicios → Credenciales → tu Client ID → Client Secret, y añádelo como variable de entorno antes de repetir esto.</p>'));
    return;
  }

  try {
    const { tokens } = await clienteOAuth().getToken(code);

    if (!tokens.refresh_token) {
      res.status(200).send(paginaResultado('Sin refresh token', `
        <h1>Google no ha mandado un refresh token esta vez</h1>
        <div class="aviso">Suele pasar si ya habías dado acceso antes. Ve a
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>,
        quita el acceso de "Kaska.Climb", y vuelve a entrar por
        <a href="/api/listar-clientes?accion=drive-oauth-inicio">?accion=drive-oauth-inicio</a>.</div>`));
      return;
    }

    res.status(200).send(paginaResultado('Copia esto a Vercel', `
      <h1>Ya casi está — un último paso</h1>
      <p>Copia este valor:</p>
      <textarea readonly onclick="this.select()">${tokens.refresh_token}</textarea>
      <ol>
        <li>Ve a Vercel → tu proyecto → <strong>Settings → Environment Variables</strong>.</li>
        <li>Crea una variable nueva llamada <code>GOOGLE_TRAINER_REFRESH_TOKEN</code> con el valor de arriba.</li>
        <li>Guarda, y vuelve a desplegar (Vercel te lo pedirá, o haz un pequeño cambio y súbelo).</li>
      </ol>
      <p>A partir de ahí, las carpetas de clientes nuevos nacerán ya a tu nombre. No hace falta volver a repetir esto.</p>`));
  } catch (e) {
    res.status(500).send(paginaResultado('Error', `<h1>No se pudo completar</h1><p>${e.message}</p>`));
  }
}

// GET ?accion=drive-picker-token — access token corto para que
// conectar-drive.html pueda abrir el selector nativo de Google Drive en el
// navegador del entrenador (drive.file no da acceso a nada que la app no
// haya creado hasta que el propio entrenador lo elige a mano ahí). Nunca se
// guarda en ningún sitio, solo vive en memoria de esa pestaña.
async function manejarDrivePickerToken(req, res) {
  if (!exigirEntrenador(req, res)) return;
  try {
    const token = await obtenerAccessTokenEntrenador();
    res.status(200).json({ success: true, accessToken: token, clientId: GOOGLE_CLIENT_ID });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.accion === 'drive-oauth-inicio') {
    return await manejarDriveOAuthInicio(req, res);
  }
  if (req.method === 'GET' && req.query && req.query.accion === 'drive-oauth-callback') {
    return await manejarDriveOAuthCallback(req, res);
  }
  if (req.method === 'GET' && req.query && req.query.accion === 'backup-diario') {
    return await manejarBackupDiario(req, res);
  }
  if (req.method === 'GET' && req.query && req.query.accion === 'drive-picker-token') {
    return await manejarDrivePickerToken(req, res);
  }

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
    if (req.method === 'GET' && req.query && req.query.accion === 'revisar-caducados') return await manejarRevisarCaducados(req, res, sheets);
    if (req.method === 'GET' && req.query && req.query.accion === 'estado-sistema') return await manejarEstadoSistema(req, res, sheets);
    if (req.method === 'GET' && req.query && req.query.accion === 'notif-leidas') return await manejarNotifLeidasGet(req, res, sheets);
    if (req.method === 'GET' && req.query && req.query.accion === 'sincronizar-fecha-inicio') return await manejarSincronizarFechaInicio(req, res, sheets);
    if (req.method === 'GET') return await manejarGet(req, res, sheets);
    if (req.body && req.body.accion === 'alta') return await manejarAlta(req, res, sheets);
    if (req.body && req.body.accion === 'eliminar') return await manejarEliminar(req, res, sheets);
    if (req.body && req.body.accion === 'marcar-notif-leida') return await manejarMarcarNotifLeida(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
