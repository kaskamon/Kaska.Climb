const { google } = require('googleapis');
const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Sesiones_Programadas';

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}
function formatFecha(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
}

// Dado cualquier fecha de referencia, devuelve las 7 fechas (dd/mm/aaaa) de esa
// semana, Lunes a Domingo.
function diasDeLaSemana(ref) {
  const diaSemana = ref.getDay(); // 0=domingo .. 6=sábado
  const offsetALunes = diaSemana === 0 ? -6 : 1 - diaSemana;
  const lunes = new Date(ref);
  lunes.setDate(lunes.getDate() + offsetALunes);

  const dias = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lunes);
    d.setDate(d.getDate() + i);
    dias.push(formatFecha(d));
  }
  return dias;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, fecha } = req.query || {};
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

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

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

    // Sin fecha explícita: usamos el día de la fila más reciente publicada
    // para este cliente (de abajo a arriba) como referencia — así "Cargar
    // último publicado" no depende de que el entrenador escriba antes el
    // lunes de la semana.
    let ref;
    if (fecha) {
      ref = parseFechaDDMMYYYY(fecha) || new Date();
    } else {
      let ultimaFecha = null;
      for (let i = filas.length - 1; i >= 0; i--) {
        if (filas[i][1] === cliente) { ultimaFecha = filas[i][2]; break; }
      }
      ref = (ultimaFecha && parseFechaDDMMYYYY(ultimaFecha)) || new Date();
    }
    const dias = diasDeLaSemana(ref);

    // Para cada (fecha, mesociclo) del cliente en esta semana, nos quedamos con
    // la publicación más reciente (las filas van en orden de inserción, así que
    // sobreescribir según avanzamos ya nos deja la última).
    const porDiaYMeso = new Map();
    filas.forEach(f => {
      const filaCliente = f[1], filaFecha = f[2], filaMesociclo = f[3];
      if (filaCliente !== cliente || !dias.includes(filaFecha)) return;
      porDiaYMeso.set(filaFecha + '|' + filaMesociclo, { fecha: filaFecha, mesociclo: filaMesociclo });
    });

    res.status(200).json({ success: true, dias, sesiones: Array.from(porDiaYMeso.values()) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
