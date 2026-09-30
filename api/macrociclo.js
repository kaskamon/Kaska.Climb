const { verificarAccesoCliente, verificarEntrenador } = require('../libs/sesion-cliente.js');
const { exigirEntrenadorOCron } = require('../libs/entrenador-notificaciones.js');
const { authSheets: authSheetsCacheado, SCOPE_LECTURA_ESCRITURA } = require('../libs/sheets-auth.js');
const { semanasDelMacrociclo, calcularFaseYSemana, lunesDe, formatFechaDDMMYYYY, parseFechaDDMMYYYY } = require('../libs/planificacion-semanas.js');
const { sanearFormula } = require('../libs/sheets-sanitize.js');
const { COLUMNS } = require('../libs/mesociclos-config.js');
const CUMPLIMIENTO_SEMANAL = require('../libs/cumplimiento-semanal.js');

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
// Historial real de sesiones enviadas por el cliente (mismo Sheet que lee
// api/obtener-historial.js) — a diferencia de Sesiones_Programadas (el plan
// del entrenador, que se poda a las 2 últimas semanas en cada publicación,
// ver api/publicar-sesion.js), esta pestaña nunca se borra. La rejilla de
// Programación la usa solo para saber si un cliente entrenó una semana
// aunque su fila programada ya no exista — no para recuperar qué se le
// mandó hacer ese día, ese detalle sí se pierde con la poda.
const RESPUESTAS_SHEET = 'Respuestas de formulario 1';
const COL_RESPUESTAS_CORREO = 34; // AI



// Sheet de clientes (distinto del de sesiones/macrociclos) — mismo que usa
// api/listar-clientes.js.
const CLIENTES_SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const CLIENTES_SHEET_NAME = 'Respuestas de formulario 1';
const COL_CLIENTES = { estado: 1, nombre: 3, apellidos: 4, correo: 6 };

function authSheets() {
  return authSheetsCacheado(SCOPE_LECTURA_ESCRITURA);
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
  // Límite por bloque (no solo cosmético en Macrociclos.html): la rejilla de
  // Programación (accion=grid) calcula semana a semana TODOS los clientes en
  // una sola petición — un número desorbitado aquí puede hacer que esa
  // petición se quede colgada o falle para todo el mundo, no solo para este
  // cliente.
  const semanasInvalidas = bloques.some(b => !Number.isFinite(Number(b.semanas)) || Number(b.semanas) < 1 || Number(b.semanas) > 104);
  if (semanasInvalidas) {
    return res.status(400).json({ success: false, error: 'Cada bloque debe durar entre 1 y 104 semanas.' });
  }

  const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const correoNorm = correo.trim().toLowerCase();
  const fila = [marcaTemporal, sanearFormula(correo.trim()), sanearFormula(nombre), sanearFormula(inicio || ''), sanearFormula(fin || ''), JSON.stringify(bloques)];

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
// macrociclos + todas las semanas ya publicadas — la usa la rejilla de
// Programación (manejarGrid), para no repetir una llamada a Sheets por
// cliente.
async function datosBaseParaRevision(sheets) {
  const [respClientes, respMacros, respProgramadas, respHistorial] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: CLIENTES_SPREADSHEET_ID, range: `'${CLIENTES_SHEET_NAME}'!A:N` }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:F` }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SESIONES_PROGRAMADAS_SHEET}'!A:D` }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${RESPUESTAS_SHEET}'!A:AI` }),
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

  // Semanas con constancia real de entreno (el cliente llegó a enviar una
  // sesión), aunque Sesiones_Programadas ya la haya podado por antigüedad.
  // Guarda el mesociclo entrenado para poder colorear la celda igual que si
  // estuviera publicada, en vez de darla por "sin publicar".
  const semanasEntrenadas = new Map(); // "correo|timestampDelLunes" -> mesociclo
  (respHistorial.data.values || []).slice(1).forEach(f => {
    const correo = (f[COL_RESPUESTAS_CORREO] || '').trim().toLowerCase();
    const mesociclo = (f[3] || '').trim();
    const fechaFila = parseFechaDDMMYYYY(f[2]);
    if (!correo || !fechaFila) return;
    const key = correo + '|' + lunesDe(fechaFila).getTime();
    if (!semanasEntrenadas.has(key)) semanasEntrenadas.set(key, mesociclo);
  });

  return { clientesActivos, macrociclosPorCorreo, semanasPublicadas, semanasEntrenadas };
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
    const { clientesActivos, macrociclosPorCorreo, semanasPublicadas, semanasEntrenadas } = await datosBaseParaRevision(sheets);

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
            const publicada = semanasPublicadas.has(key);
            const mesocicloEntrenado = !publicada ? semanasEntrenadas.get(key) : undefined;
            return {
              ...s,
              publicada,
              // Sin fila en Sesiones_Programadas (podada por antigüedad) pero con
              // constancia de que el cliente sí entrenó esa semana — no es lo
              // mismo que "sin publicar" de verdad, aunque ya no se pueda
              // recuperar QUÉ se le programó ese día.
              entrenadaSinPublicar: !!mesocicloEntrenado,
              mesocicloEntrenado: mesocicloEntrenado || undefined,
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

// GET ?accion=semana-siguiente-pendientes — clientes activos con macrociclo
// a los que les falta programar la semana que empieza el LUNES QUE VIENE.
// Seguimiento.html solo la consulta sábado y domingo (entre semana el lunes
// siguiente está a 3-6 días vista, demasiado pronto para avisar) — pero
// lunesSiguiente es el mismo lunes tanto el sábado como el domingo, así que
// el aviso persiste hasta que se marca leída, igual que "inactivo"/"vence",
// no solo el día en que se detecta por primera vez.
// Llamada AJAX desde una página ya protegida por middleware.js, igual que
// manejarGrid — basta con el 401 JSON de verificarEntrenador.
async function manejarSemanaSiguientePendientes(req, res, sheets) {
  const acceso = verificarEntrenador(req);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });

  try {
    const { clientesActivos, macrociclosPorCorreo, semanasPublicadas } = await datosBaseParaRevision(sheets);

    const lunesSiguiente = lunesDe(new Date());
    lunesSiguiente.setDate(lunesSiguiente.getDate() + 7);
    const fechaLunesSiguiente = formatFechaDDMMYYYY(lunesSiguiente);

    const pendientes = clientesActivos
      .map(c => {
        const plan = macrociclosPorCorreo.get(c.correo.toLowerCase());
        if (!plan || !plan.inicio) return null;
        const calc = calcularFaseYSemana(plan.inicio, plan.bloques, fechaLunesSiguiente);
        if (calc.fueraDeRango) return null; // ese cliente no tiene macrociclo esa semana — nada que avisar
        const key = c.correo.toLowerCase() + '|' + lunesSiguiente.getTime();
        if (semanasPublicadas.has(key)) return null; // ya está publicada

        return { correo: c.correo, nombre: c.nombre || plan.nombre, mesociclo: calc.mesociclo, fechaLunesSiguiente };
      })
      .filter(Boolean);

    res.status(200).json({ success: true, pendientes });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// GET ?accion=historial&cliente=correo — TODOS los macrociclos publicados
// para ese cliente (no solo el más reciente, que es lo que da manejarGet),
// más recientes primero. Lo usa Seguimiento.html para dejar elegir qué
// macrociclo(s) exportar en el PDF cuando el cliente ha entrenado contigo
// en más de una etapa a lo largo del tiempo.
async function manejarHistorialMacrociclos(req, res, sheets) {
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
      error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}).`,
    });
  }

  const correoBuscado = cliente.trim().toLowerCase();
  // inicio/fin son "aaaa-mm-dd" (de <input type="date">) — ese formato ya
  // ordena bien como texto, sin necesidad de parsear a Date.
  const macrociclos = filas
    .filter(f => (f[1] || '').trim().toLowerCase() === correoBuscado && (f[3] || '').trim())
    .map(f => ({ inicio: (f[3] || '').trim(), fin: (f[4] || '').trim() }))
    .sort((a, b) => (a.inicio < b.inicio ? 1 : a.inicio > b.inicio ? -1 : 0));

  res.status(200).json({ success: true, macrociclos });
}

// Pestaña nueva, propia del cumplimiento semanal (ver memoria de proyecto
// proyecto_cumplimiento_semanal.md) — una fila por cliente+semana, escrita
// UNA VEZ por manejarCerrarSemanaCumplimiento y nunca más tocada. Sobrevive
// aunque Sesiones_Programadas pode esa semana después (por eso hace falta
// esta pestaña: lo programado desaparece de ahí a las 2 semanas).
const CUMPLIMIENTO_SHEET = 'Cumplimiento_Semanal';
const CUMPLIMIENTO_CABECERA = ['Marca temporal', 'Correo', 'Lunes semana', 'Mesociclo', 'Puntos conseguidos', 'Puntos posibles', 'Porcentaje'];

// Igual que el "entrenada" de api/obtener-historial.js: la señal habitual es
// el test de Fmax (fmaxIzq); TAPERING no lo tiene, usa en su lugar el primer
// campo de campos[] (Susp).
function entrenadaDeFilaRoco(cfg, f) {
  if (!cfg) return false;
  if (cfg.fmaxIzq !== undefined) return f[cfg.fmaxIzq] !== undefined && f[cfg.fmaxIzq] !== '';
  if (Array.isArray(cfg.campos) && cfg.campos[0] !== undefined) return f[cfg.campos[0]] !== undefined && f[cfg.campos[0]] !== '';
  return true;
}

async function asegurarPestanaCumplimiento(sheets) {
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${CUMPLIMIENTO_SHEET}'!A1:A1` });
  } catch (e) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: CUMPLIMIENTO_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${CUMPLIMIENTO_SHEET}'!A1:G1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [CUMPLIMIENTO_CABECERA] },
    });
  }
}

// Construye, para un cliente+semana+mesociclo concretos, las sesiones roco y
// gym REALMENTE programadas esa semana (leídas de Sesiones_Programadas) con
// su resultado real (leído de Respuestas de formulario 1) — puro cálculo, sin
// red, a partir de filas ya leídas.
function construirSemanaDesdeProgramadas(correo, lunesFecha, filasProgramadas, filasRespuestas) {
  const lunesMs = lunesFecha.getTime();
  const domingoMs = lunesMs + 6 * 86400000 + 86399999; // hasta el final del domingo
  const correoNorm = correo.trim().toLowerCase();

  const programadasSemana = filasProgramadas.filter(f => {
    const correoFila = (f[1] || '').trim().toLowerCase();
    if (correoFila !== correoNorm) return false;
    const fechaFila = parseFechaDDMMYYYY(f[2]);
    if (!fechaFila) return false;
    const t = fechaFila.getTime();
    return t >= lunesMs && t <= domingoMs;
  });

  const buscarRespuesta = (fecha, mesociclo) => filasRespuestas.find(f =>
    (f[COL_RESPUESTAS_CORREO] || '').trim().toLowerCase() === correoNorm &&
    f[2] === fecha && f[3] === mesociclo
  );

  const sesionesRoco = [];
  const sesionesGym = [];
  programadasSemana.forEach(f => {
    const mesociclo = f[3];
    const fecha = f[2];
    if (CUMPLIMIENTO_SEMANAL.MESOCICLOS_ROCO_PUNTUABLES.includes(mesociclo)) {
      const cfg = COLUMNS[mesociclo];
      const fila = buscarRespuesta(fecha, mesociclo);
      const entrenada = !!fila && entrenadaDeFilaRoco(cfg, fila);
      const campos = fila && Array.isArray(cfg.campos) ? cfg.campos.map(col => fila[col]) : [];
      // intentada: hay fila ese día (llegó a hacer al menos el PFinicial),
      // aunque se bloqueara por no estar recuperado. Sin fila = todavía no
      // le ha tocado/no la ha hecho — no es lo mismo que "no recuperado"
      // (eso implica que sí lo intentó), así que el front debe distinguirlas.
      sesionesRoco.push({ mesociclo, fecha, entrenada, intentada: !!fila, campos });
    } else if (CUMPLIMIENTO_SEMANAL.MESOCICLOS_GYM.includes(mesociclo)) {
      const fila = buscarRespuesta(fecha, mesociclo);
      sesionesGym.push({ mesociclo, fecha, entrenada: !!fila });
    }
    // ROCA/DESCANSO/cualquier otra cosa: no puntúan, se ignoran.
  });

  return { sesionesRoco, sesionesGym };
}

// GET ?accion=cerrar-semana-cumplimiento — cron del domingo (ver vercel.json):
// calcula y congela el % de cumplimiento de la semana que acaba de terminar,
// para CADA cliente activo con macrociclo, mientras Sesiones_Programadas
// todavía tiene el dato real de lo programado (se poda a las 2 semanas).
async function manejarCerrarSemanaCumplimiento(req, res, sheets) {
  if (!exigirEntrenadorOCron(req, res)) return;

  try {
    const [respClientes, respMacros, respProgramadas, respRespuestas] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: CLIENTES_SPREADSHEET_ID, range: `'${CLIENTES_SHEET_NAME}'!A:N` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:F` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SESIONES_PROGRAMADAS_SHEET}'!A:D` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${RESPUESTAS_SHEET}'!A:AL` }),
    ]);
    await asegurarPestanaCumplimiento(sheets);

    const clientesActivos = (respClientes.data.values || [])
      .filter(f => (f[COL_CLIENTES.estado] || '').trim().toLowerCase() === 'activo' && (f[COL_CLIENTES.correo] || '').trim())
      .map(f => (f[COL_CLIENTES.correo] || '').trim());

    const macrociclosPorCorreo = new Map();
    (respMacros.data.values || []).forEach(f => {
      const correo = (f[1] || '').trim().toLowerCase();
      if (!correo) return;
      let bloques;
      try { bloques = JSON.parse(f[5] || '[]'); } catch (e) { return; }
      macrociclosPorCorreo.set(correo, { inicio: f[3] || '', bloques });
    });

    const filasProgramadas = respProgramadas.data.values || [];
    const filasRespuestas = (respRespuestas.data.values || []).slice(1); // sin cabecera

    const hoy = new Date();
    const lunesHoy = lunesDe(hoy);
    const lunesFechaTexto = formatFechaDDMMYYYY(lunesHoy);

    const filasNuevas = [];
    const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    clientesActivos.forEach(correo => {
      const plan = macrociclosPorCorreo.get(correo.toLowerCase());
      if (!plan || !plan.inicio) return;
      const calc = calcularFaseYSemana(plan.inicio, plan.bloques, lunesFechaTexto);
      if (calc.fueraDeRango) return;

      const { sesionesRoco, sesionesGym } = construirSemanaDesdeProgramadas(correo, lunesHoy, filasProgramadas, filasRespuestas);
      const r = CUMPLIMIENTO_SEMANAL.calcularCumplimientoSemana(sesionesRoco, sesionesGym);
      if (r.posible <= 0) return; // nada programado esa semana (p.ej. ROCA/DESCANSO sin gym) -- no hay nada que congelar
      filasNuevas.push([marcaTemporal, sanearFormula(correo), lunesFechaTexto, calc.mesociclo, r.puntos, r.posible, r.porcentaje]);
    });

    if (filasNuevas.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${CUMPLIMIENTO_SHEET}'!A:G`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: filasNuevas },
      });
    }

    res.status(200).json({ success: true, semana: lunesFechaTexto, procesados: filasNuevas.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// Semana histórica SIN registro real de lo programado (Sesiones_Programadas
// ya la podó) — asume la plantilla estándar 2 roco + 1 gym, y busca en
// Respuestas de formulario 1 lo que de verdad se entrenó esa semana (hasta 2
// filas del mesociclo roco de esa semana, cualquier fila de gym). Decisión
// cerrada con el usuario el 30/09/2026 — ver proyecto_cumplimiento_semanal.md.
function calcularSemanaAsumida(correo, lunesFecha, mesociclo, filasRespuestas) {
  const lunesMs = lunesFecha.getTime();
  const domingoMs = lunesMs + 6 * 86400000 + 86399999;
  const correoNorm = correo.trim().toLowerCase();
  const filasSemana = filasRespuestas.filter(f => {
    if ((f[COL_RESPUESTAS_CORREO] || '').trim().toLowerCase() !== correoNorm) return false;
    const fecha = parseFechaDDMMYYYY(f[2]);
    if (!fecha) return false;
    const t = fecha.getTime();
    return t >= lunesMs && t <= domingoMs;
  });

  let puntos = 0, posible = 0;
  if (CUMPLIMIENTO_SEMANAL.MESOCICLOS_ROCO_PUNTUABLES.includes(mesociclo)) {
    const cfg = COLUMNS[mesociclo];
    const maxPorSesion = CUMPLIMIENTO_SEMANAL.puntosSesionRoco(mesociclo, []).posible;
    posible += maxPorSesion * 2; // plantilla asumida: 2 roco
    filasSemana.filter(f => f[3] === mesociclo).slice(0, 2).forEach(f => {
      if (!entrenadaDeFilaRoco(cfg, f)) return;
      const campos = Array.isArray(cfg.campos) ? cfg.campos.map(col => f[col]) : [];
      puntos += CUMPLIMIENTO_SEMANAL.puntosSesionRoco(mesociclo, campos).puntos;
    });
  }
  posible += CUMPLIMIENTO_SEMANAL.PESO_GYM; // plantilla asumida: 1 gym
  if (filasSemana.some(f => CUMPLIMIENTO_SEMANAL.MESOCICLOS_GYM.includes(f[3]))) puntos += CUMPLIMIENTO_SEMANAL.PESO_GYM;

  if (posible > 0 && puntos > posible) puntos = posible;
  const porcentaje = posible > 0 ? Math.round((puntos / posible) * 1000) / 10 : null;
  return { puntos, posible, porcentaje };
}

// GET ?accion=backfill-cumplimiento — migración manual, de un solo uso (la
// dispara el entrenador a mano, no un cron): para cada cliente activo con
// macrociclo, rellena en Cumplimiento_Semanal todas las semanas PASADAS
// (nunca la actual ni futuras, de eso ya se encargan el cron semanal y la
// lectura en vivo) que todavía no tengan fila, usando la plantilla asumida
// 2+1. Si se ejecuta más de una vez, nunca pisa una fila que ya exista
// (ni las que puso el cron semanal ni las de una ejecución anterior de esto).
async function manejarBackfillCumplimiento(req, res, sheets) {
  if (!exigirEntrenadorOCron(req, res)) return;

  try {
    const [respClientes, respMacros, respRespuestas, respCumplimiento] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: CLIENTES_SPREADSHEET_ID, range: `'${CLIENTES_SHEET_NAME}'!A:N` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:F` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${RESPUESTAS_SHEET}'!A:AL` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${CUMPLIMIENTO_SHEET}'!A:G` }).catch(() => ({ data: { values: [] } })),
    ]);
    await asegurarPestanaCumplimiento(sheets);

    const clientesActivos = (respClientes.data.values || [])
      .filter(f => (f[COL_CLIENTES.estado] || '').trim().toLowerCase() === 'activo' && (f[COL_CLIENTES.correo] || '').trim())
      .map(f => (f[COL_CLIENTES.correo] || '').trim());

    const macrociclosPorCorreo = new Map();
    (respMacros.data.values || []).forEach(f => {
      const correo = (f[1] || '').trim().toLowerCase();
      if (!correo) return;
      let bloques;
      try { bloques = JSON.parse(f[5] || '[]'); } catch (e) { return; }
      macrociclosPorCorreo.set(correo, { inicio: f[3] || '', bloques });
    });

    const filasRespuestas = (respRespuestas.data.values || []).slice(1);

    const yaCongeladas = new Set(); // "correo|lunesTexto"
    (respCumplimiento.data.values || []).slice(1).forEach(f => {
      yaCongeladas.add((f[1] || '').trim().toLowerCase() + '|' + (f[2] || '').trim());
    });

    const lunesHoyMs = lunesDe(new Date()).getTime();
    const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    const filasNuevas = [];

    clientesActivos.forEach(correo => {
      const plan = macrociclosPorCorreo.get(correo.toLowerCase());
      if (!plan || !plan.inicio) return;
      const { semanas } = semanasDelMacrociclo(plan.inicio, plan.bloques);
      semanas.forEach(s => {
        if (!s.mesociclo) return;
        const lunesFecha = parseFechaDDMMYYYY(s.fechaLunes);
        if (!lunesFecha || lunesFecha.getTime() >= lunesHoyMs) return; // la actual/futuras no se tocan aquí
        const key = correo.toLowerCase() + '|' + s.fechaLunes;
        if (yaCongeladas.has(key)) return;
        const r = calcularSemanaAsumida(correo, lunesFecha, s.mesociclo, filasRespuestas);
        if (r.posible <= 0) return;
        filasNuevas.push([marcaTemporal, sanearFormula(correo), s.fechaLunes, s.mesociclo, r.puntos, r.posible, r.porcentaje]);
      });
    });

    if (filasNuevas.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${CUMPLIMIENTO_SHEET}'!A:G`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: filasNuevas },
      });
    }

    res.status(200).json({ success: true, procesados: filasNuevas.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// GET ?accion=cumplimiento&cliente=correo — cumplimiento semanal para la
// página del cliente: la semana en curso calculada en vivo (Sesiones_
// Programadas todavía tiene el dato fresco), más el total acumulado sumando
// todo lo ya congelado en Cumplimiento_Semanal.
async function manejarCumplimiento(req, res, sheets) {
  const { cliente } = req.query || {};
  if (!cliente) return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
  const acceso = verificarAccesoCliente(req, cliente);
  if (!acceso.ok) return res.status(401).json({ success: false, error: acceso.error });

  try {
    const [respMacros, respProgramadas, respRespuestas, respCumplimiento] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:F` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SESIONES_PROGRAMADAS_SHEET}'!A:D` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${RESPUESTAS_SHEET}'!A:AL` }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${CUMPLIMIENTO_SHEET}'!A:G` }).catch(() => ({ data: { values: [] } })),
    ]);

    const correoNorm = cliente.trim().toLowerCase();
    let plan = null;
    (respMacros.data.values || []).forEach(f => {
      if ((f[1] || '').trim().toLowerCase() === correoNorm) plan = { inicio: f[3] || '', bloques: (() => { try { return JSON.parse(f[5] || '[]'); } catch (e) { return []; } })() };
    });
    if (!plan || !plan.inicio) return res.status(200).json({ success: true, semanaActual: null, total: null });

    const filasProgramadas = respProgramadas.data.values || [];
    const filasRespuestas = (respRespuestas.data.values || []).slice(1);
    const filasCumplimiento = (respCumplimiento.data.values || []).slice(1)
      .filter(f => (f[1] || '').trim().toLowerCase() === correoNorm);

    // Semana en curso, calculada en vivo (todavía no congelada).
    const hoy = new Date();
    const lunesHoy = lunesDe(hoy);
    const lunesFechaTexto = formatFechaDDMMYYYY(lunesHoy);
    const calc = calcularFaseYSemana(plan.inicio, plan.bloques, lunesFechaTexto);
    let semanaActual = null;
    if (!calc.fueraDeRango) {
      const { sesionesRoco, sesionesGym } = construirSemanaDesdeProgramadas(cliente, lunesHoy, filasProgramadas, filasRespuestas);
      const r = CUMPLIMIENTO_SEMANAL.calcularCumplimientoSemana(sesionesRoco, sesionesGym);
      const detalleRoco = sesionesRoco.map(s => ({
        mesociclo: s.mesociclo, fecha: s.fecha, entrenada: s.entrenada, intentada: s.intentada,
        detalle: CUMPLIMIENTO_SEMANAL.detalleSesionRoco(s.mesociclo, s.campos),
      }));
      const detalleGym = sesionesGym.map(s => ({ mesociclo: s.mesociclo, fecha: s.fecha, entrenada: s.entrenada }));
      semanaActual = { lunes: lunesFechaTexto, mesociclo: calc.mesociclo, ...r, sesionesRoco: detalleRoco, sesionesGym: detalleGym };
    }

    // Total acumulado: suma de lo ya congelado + la semana en curso (si tiene
    // algo puntuable), puntos conseguidos / puntos posibles de siempre.
    let puntosTotal = 0, posibleTotal = 0;
    filasCumplimiento.forEach(f => { puntosTotal += Number(f[4]) || 0; posibleTotal += Number(f[5]) || 0; });
    if (semanaActual && semanaActual.posible > 0) { puntosTotal += semanaActual.puntos; posibleTotal += semanaActual.posible; }
    const total = posibleTotal > 0 ? { puntos: puntosTotal, posible: posibleTotal, porcentaje: Math.round((puntosTotal / posibleTotal) * 1000) / 10 } : null;

    res.status(200).json({ success: true, semanaActual, total });
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
    if (req.method === 'GET' && accion === 'grid') return await manejarGrid(req, res, sheets);
    if (req.method === 'GET' && accion === 'semana-siguiente-pendientes') return await manejarSemanaSiguientePendientes(req, res, sheets);
    if (req.method === 'GET' && accion === 'historial') return await manejarHistorialMacrociclos(req, res, sheets);
    if (req.method === 'GET' && accion === 'cerrar-semana-cumplimiento') return await manejarCerrarSemanaCumplimiento(req, res, sheets);
    if (req.method === 'GET' && accion === 'backfill-cumplimiento') return await manejarBackfillCumplimiento(req, res, sheets);
    if (req.method === 'GET' && accion === 'cumplimiento') return await manejarCumplimiento(req, res, sheets);
    if (req.method === 'GET') return await manejarGet(req, res, sheets);
    return await manejarPost(req, res, sheets);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
