const { google } = require('googleapis');
const { COLUMNS } = require('../libs/mesociclos-config.js');
const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Respuestas de formulario 1';
const COL_CORREO = 34; // AI — mismo campo que escribe api/enviar-sesion.js

// Mesociclos con seguimiento numérico real (los únicos que miden PFinicial).
// GYM-FMAX, GYM-ANTAGONISTAS, ROCA, DESCANSO y TAPERING no llevan estos datos
// a propósito, así que nunca tienen nada que enseñar aquí.
const MESOCICLOS_CON_DATOS = Object.keys(COLUMNS).filter(m => COLUMNS[m] && COLUMNS[m].pfInicial !== undefined);

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d).getTime();
}

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
        _t: parseFechaDDMMYYYY(f[2]),
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
      };
    })
    .slice(-max);
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

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:AI`,
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

    // Sin mesociclo: los 4 con seguimiento real, agrupados — para el panel de
    // Seguimiento (una pestaña por mesociclo, sin volver a pedir cada una).
    const porMesociclo = {};
    MESOCICLOS_CON_DATOS.forEach(m => {
      porMesociclo[m] = extraerHistorialDeMesociclo(filas, cliente, m, Number(limite) || 60);
    });
    res.status(200).json({ success: true, porMesociclo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
