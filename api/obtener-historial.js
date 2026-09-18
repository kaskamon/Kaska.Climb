const { COLUMNS } = require('../libs/mesociclos-config.js');
const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');
const { authSheets, SCOPE_SOLO_LECTURA } = require('../libs/sheets-auth.js');
const { parseFechaDDMMYYYY } = require('../libs/planificacion-semanas.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const COL_CORREO = 34; // AI — mismo campo que escribe api/enviar-sesion.js
const COL_NOTAS = 35; // AJ — nota libre opcional que deja el cliente al enviar la sesión

// Mesociclos con seguimiento numérico real (los únicos que miden PFinicial).
// GYM-FMAX, GYM-ANTAGONISTAS, ROCA, DESCANSO y TAPERING no llevan estos datos
// a propósito, así que nunca tienen nada que enseñar aquí.
const MESOCICLOS_CON_DATOS = Object.keys(COLUMNS).filter(m => COLUMNS[m] && COLUMNS[m].pfInicial !== undefined);

// "Dominadas con lastre" (columna E) — a diferencia de los campos de arriba,
// no depende de que el mesociclo de ese día sea literalmente GYM-FMAX: ese
// bloque puede aparecer en cualquier sesión de gimnasio (ver
// api/enviar-sesion.js, COL_DOMINADAS_CON_LASTRE), así que se recoge por
// columna con valor, sin filtrar por mesociclo.
const COL_DOMINADAS_CON_LASTRE = 4;
// Clave especial en porMesociclo (no es un mesociclo real) para esta serie —
// Seguimiento.html la ofrece como variable extra dentro de la pestaña FMAX.
const CLAVE_DOMINADAS = 'DOMINADAS_LASTRE';

// Para el chequeo de recuperación de cliente/sesion.html: el PFinicial y el
// Fmax reflejan el estado físico real del cliente en ese momento, no algo
// que "empiece de cero" solo porque el macrociclo pasa de un mesociclo a
// otro (p.ej. de REOX a DESOX) — así que la referencia se busca en el
// histórico de CUALQUIER mesociclo con datos (FMAX/REOX/DESOX/AERO/
// TAPERING), no solo en el mesociclo que se está entrenando hoy. Si no se
// hiciera así, la primera sesión de cada mesociclo nuevo se quedaría
// siempre sin referencia con la que comparar la recuperación, aunque el
// cliente hubiera entrenado el día anterior.
function extraerHistorialCrossMesociclo(filas, cliente, max) {
  return filas
    .filter(f => f[COL_CORREO] === cliente)
    .map(f => {
      const filaMesociclo = f[3];
      const cfg = COLUMNS[filaMesociclo];
      if (!cfg || cfg.pfInicial === undefined) return null;
      if (f[cfg.pfInicial] === undefined || f[cfg.pfInicial] === '') return null;
      const fmaxIzq = cfg.fmaxIzq !== undefined ? f[cfg.fmaxIzq] : undefined;
      const fmaxDer = cfg.fmaxDer !== undefined ? f[cfg.fmaxDer] : undefined;
      const pfFinalRaw = cfg.pfFinal !== undefined && cfg.pfFinal !== null ? f[cfg.pfFinal] : undefined;
      const entrenada = cfg.fmaxIzq !== undefined ? (fmaxIzq !== undefined && fmaxIzq !== '') : true;
      return {
        fecha: f[2],
        _t: parseFechaDDMMYYYY(f[2])?.getTime(),
        mesociclo: filaMesociclo,
        pfInicial: Number(f[cfg.pfInicial]),
        entrenada,
        fmaxIzq: fmaxIzq !== undefined && fmaxIzq !== '' ? Number(fmaxIzq) : undefined,
        fmaxDer: fmaxDer !== undefined && fmaxDer !== '' ? Number(fmaxDer) : undefined,
        pfFinal: pfFinalRaw !== undefined && pfFinalRaw !== '' ? Number(pfFinalRaw) : undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a._t ?? -Infinity) - (b._t ?? -Infinity))
    .map(({ _t, ...resto }) => resto)
    .slice(-max);
}

function extraerHistorialDeMesociclo(filas, cliente, mesociclo, max) {
  const cfg = COLUMNS[mesociclo];
  if (!cfg || cfg.pfInicial === undefined) return [];

  return filas
    .filter(f => f[COL_CORREO] === cliente && f[3] === mesociclo && f[cfg.pfInicial] !== undefined && f[cfg.pfInicial] !== '')
    .map(f => {
      // Si ese día se registró algo más allá del PFinicial (p.ej. la Fmax), la
      // sesión se entrenó de verdad. Si no, fue un día bloqueado por no estar
      // recuperado, y no cuenta como referencia para sesiones futuras. Los
      // mesociclos que ni siquiera miden Fmax (TAPERING) no tienen esa señal
      // — ahí cualquier fila con PFinicial ya cuenta como entrenada, porque
      // no hay forma de distinguir un día bloqueado sin el test de Fmax.
      const fmaxIzq = cfg.fmaxIzq !== undefined ? f[cfg.fmaxIzq] : undefined;
      const fmaxDer = cfg.fmaxDer !== undefined ? f[cfg.fmaxDer] : undefined;
      const pfFinalRaw = cfg.pfFinal !== undefined && cfg.pfFinal !== null ? f[cfg.pfFinal] : undefined;
      const entrenada = cfg.fmaxIzq !== undefined ? (fmaxIzq !== undefined && fmaxIzq !== '') : true;
      const campos = Array.isArray(cfg.campos)
        ? cfg.campos.map(col => (f[col] !== undefined && f[col] !== '' ? Number(f[col]) : undefined))
        : undefined;
      return {
        fecha: f[2],
        pfInicial: Number(f[cfg.pfInicial]),
        entrenada,
        fmaxIzq: fmaxIzq !== undefined && fmaxIzq !== '' ? Number(fmaxIzq) : undefined,
        fmaxDer: fmaxDer !== undefined && fmaxDer !== '' ? Number(fmaxDer) : undefined,
        pfFinal: pfFinalRaw !== undefined && pfFinalRaw !== '' ? Number(pfFinalRaw) : undefined,
        campos,
        notas: f[COL_NOTAS] || undefined,
      };
    })
    .slice(-max);
}

function extraerHistorialDominadas(filas, cliente, max) {
  return filas
    .filter(f => f[COL_CORREO] === cliente && f[COL_DOMINADAS_CON_LASTRE] !== undefined && f[COL_DOMINADAS_CON_LASTRE] !== '')
    .map(f => ({ fecha: f[2], valor: Number(f[COL_DOMINADAS_CON_LASTRE]) }))
    .slice(-max);
}

// Días de gimnasio (GYM-FMAX / GYM-ANTAGONISTAS) para verlos en Seguimiento,
// solo como registro de "ese día se hizo gimnasio" — no entran en ningún
// cálculo (PFinicial, gráficas...). Una fila de gimnasio no dice a qué
// mesociclo pertenece, así que se asigna al de la sesión con datos más
// cercana en el tiempo (a igualdad, la anterior): aguanta que un mismo
// mesociclo se repita en macrociclos distintos, cosa que un simple rango
// de fechas por mesociclo no distinguiría.
const MESOCICLOS_GYM = ['GYM-FMAX', 'GYM-ANTAGONISTAS'];
// Claves especiales en porMesociclo (no son mesociclos reales): GYM_EN_FMAX,
// GYM_EN_REOX... — con "fecha" en cada entrada, así Seguimiento.html las
// filtra por macrociclo igual que el resto sin tratarlas aparte.
const PREFIJO_GYM = 'GYM_EN_';

function extraerGymPorMesociclo(filas, cliente, max) {
  const delCliente = filas
    .filter(f => f[COL_CORREO] === cliente)
    .map(f => ({ f, t: parseFechaDDMMYYYY(f[2])?.getTime() }))
    .filter(x => x.t !== undefined && !Number.isNaN(x.t));

  const referencias = delCliente
    .filter(x => MESOCICLOS_CON_DATOS.includes(x.f[3]))
    .map(x => ({ t: x.t, meso: x.f[3] }));

  const resultado = {};
  MESOCICLOS_CON_DATOS.forEach(m => { resultado[m] = []; });
  if (!referencias.length) return resultado;

  delCliente
    .filter(x => MESOCICLOS_GYM.includes(x.f[3]))
    .forEach(x => {
      let mejor = referencias[0];
      referencias.forEach(r => {
        const d = Math.abs(r.t - x.t), dMejor = Math.abs(mejor.t - x.t);
        if (d < dMejor || (d === dMejor && r.t < mejor.t)) mejor = r;
      });
      const dominadas = x.f[COL_DOMINADAS_CON_LASTRE];
      resultado[mejor.meso].push({
        fecha: x.f[2],
        tipo: x.f[3],
        dominadas: dominadas !== undefined && dominadas !== '' ? Number(dominadas) : undefined,
      });
    });

  Object.keys(resultado).forEach(m => { resultado[m] = resultado[m].slice(-max); });
  return resultado;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    // "cliente" aquí es el email del cliente — es el identificador real en toda
    // la app (el nombre en columna B es solo para leer el Sheet a simple vista).
    const { cliente, mesociclo, limite } = req.query || {};

    if (!cliente) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
    }
    const acceso = verificarAccesoCliente(req, cliente);
    if (!acceso.ok) {
      return res.status(401).json({ success: false, error: acceso.error });
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }

    // Mesociclo sin datos numéricos (GYM-*, ROCA, DESCANSO, TAPERING) pedido en
    // solitario: no hay nada que calcular, pero no es un error.
    if (mesociclo && !MESOCICLOS_CON_DATOS.includes(mesociclo)) {
      return res.status(200).json({ success: true, historial: [] });
    }

    const sheets = await authSheets(SCOPE_SOLO_LECTURA);

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:AJ`,
    });
    const filas = resp.data.values || [];
    const max = Number(limite) || 10;

    // Con mesociclo: usada por cliente/sesion.html para el chequeo de
    // recuperación — cruza todos los mesociclos con datos (ver
    // extraerHistorialCrossMesociclo), no solo el que se pide, para que la
    // referencia de PFinicial/Fmax nunca desaparezca solo por haber
    // cambiado de mesociclo.
    if (mesociclo) {
      const historial = extraerHistorialCrossMesociclo(filas, cliente, max);
      return res.status(200).json({ success: true, historial });
    }

    // Sin mesociclo: los 5 con seguimiento real, agrupados — para el panel de
    // Seguimiento (una pestaña por mesociclo, sin volver a pedir cada una).
    const porMesociclo = {};
    MESOCICLOS_CON_DATOS.forEach(m => {
      porMesociclo[m] = extraerHistorialDeMesociclo(filas, cliente, m, Number(limite) || 60);
    });
    porMesociclo[CLAVE_DOMINADAS] = extraerHistorialDominadas(filas, cliente, Number(limite) || 60);
    const gym = extraerGymPorMesociclo(filas, cliente, Number(limite) || 60);
    Object.keys(gym).forEach(m => { porMesociclo[`${PREFIJO_GYM}${m}`] = gym[m]; });
    res.status(200).json({ success: true, porMesociclo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
