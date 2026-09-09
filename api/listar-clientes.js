const { google } = require('googleapis');
const { driveComoEntrenador, gmailComoEntrenador, clienteOAuth, SCOPES } = require('../libs/google-oauth-entrenador.js');
const { verificarEntrenador } = require('../libs/sesion-cliente.js');

// Correo donde llega el aviso de "cliente nuevo" — el mismo entrenador,
// mandado desde su propia cuenta (ver enviarAvisoNuevoCliente).
const CORREO_ENTRENADOR = 'kaskamon@gmail.com';

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

// Carpeta padre en Drive donde vive la carpeta de cada cliente. La carpeta de
// cada cliente se crea con la cuenta de Google del propio entrenador (ver
// libs/google-oauth-entrenador.js), no con la cuenta de servicio: una cuenta
// de servicio no puede transferir la propiedad de un archivo a una cuenta de
// Gmail normal por API (Google lo bloquea desde 2022), así que la única forma
// de que la carpeta nazca ya siendo del entrenador es crearla directamente
// como él.
const DRIVE_PARENT_ID = '16Ef_byfR5qhWQgn5YvEej3Nem8uGljBO';

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

// POST (accion: 'eliminar') — borra por completo la fila de un cliente
// (limpieza de datos de prueba, altas erróneas...). Body: { accion:'eliminar', correo }.
async function manejarEliminar(req, res, sheets) {
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

// Igual que Clientes.html — dd/mm/aaaa es el único formato de fecha que se usa en este Sheet.
function parseFechaDDMMYYYY(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec((str || '').trim());
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

// GET ?accion=revisar-caducados — pasa a Inactivo a los clientes Activos cuya
// fecha de fin ya venció, y avisa por correo si ha marcado alguno. La
// dispara sola vercel.json cada día (con el CRON_SECRET que manda Vercel
// automáticamente), o el botón "Revisar caducados ahora" de Clientes.html
// (con la contraseña de entrenador de siempre).
async function manejarRevisarCaducados(req, res, sheets) {
  const cabecera = req.headers && req.headers.authorization;
  const esCron = !!process.env.CRON_SECRET && cabecera === `Bearer ${process.env.CRON_SECRET}`;
  if (!esCron && !verificarEntrenador(req).ok) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kaska.Climb"' });
    res.end('Acceso restringido — zona de entrenador.');
    return;
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

  res.status(200).json({ success: true, marcados: caducados.length });
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

// Mismo mecanismo de construcción y envío para los dos correos de abajo —
// siempre desde la propia cuenta del entrenador (ver libs/google-oauth-entrenador.js).
async function enviarCorreoComoEntrenador(destinatario, asunto, cuerpo) {
  const gmail = gmailComoEntrenador();
  const mensajeCrudo = [
    `To: ${destinatario}`,
    `Subject: =?UTF-8?B?${Buffer.from(asunto, 'utf8').toString('base64')}?=`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    cuerpo,
  ].join('\r\n');
  const raw = Buffer.from(mensajeCrudo, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
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
// sin contraseña — lo rellena el propio cliente). Body: { accion:'alta',
// nombre, apellidos, correo, telefono, fechaNacimiento, modalidad,
// disponibilidad, lesion }. La carpeta de Drive se crea aquí mismo (ver
// crearCarpetaCliente) — antes lo hacía un Apps Script vinculado al Sheet con
// un disparador "al enviarse el formulario", pero ese disparador nunca ve las
// altas que llegan por esta API (no son un envío real del Google Form), así
// que la carpeta se dejaba de crear en silencio.
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
      range: `'${SHEET_NAME}'!A${filaInsertada}:N${filaInsertada}`,
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

// Exige la contraseña del entrenador para ?accion=drive-oauth-inicio/callback
// — a diferencia del resto de este archivo (llamadas AJAX desde páginas ya
// protegidas por middleware.js, o el alta pública), estas dos se visitan
// directamente en el navegador, así que se protegen a sí mismas con el mismo
// popup nativo (WWW-Authenticate) que usa el resto del área de entrenador.
function exigirEntrenador(req, res) {
  if (verificarEntrenador(req).ok) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kaska.Climb"' });
  res.end('Acceso restringido — zona de entrenador.');
  return false;
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

module.exports = async (req, res) => {
  if (req.method === 'GET' && req.query && req.query.accion === 'drive-oauth-inicio') {
    return await manejarDriveOAuthInicio(req, res);
  }
  if (req.method === 'GET' && req.query && req.query.accion === 'drive-oauth-callback') {
    return await manejarDriveOAuthCallback(req, res);
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
    if (req.method === 'GET') return await manejarGet(req, res, sheets);
    if (req.body && req.body.accion === 'alta') return await manejarAlta(req, res, sheets);
    if (req.body && req.body.accion === 'eliminar') return await manejarEliminar(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
