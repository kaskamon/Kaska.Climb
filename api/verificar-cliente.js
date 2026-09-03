const { google } = require('googleapis');

// Google Sheet DISTINTO al de sesiones — es el formulario de alta de clientes
// ("Base de datos clientes"), con una fila por cliente.
const SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const SHEET_NAME = 'Respuestas de formulario 1';

// Columnas reales (A=0, B=1, ...): Marca temporal, Estado, Duración, Nombre,
// Apellidos, Teléfono, Correo Electrónico, Fecha de nacimiento, ¿Lesión?,
// Modalidad, Disponibilidad para entrenar, Enlace carpeta Drive.
const COL = {
  estado: 1,
  nombre: 3,
  apellidos: 4,
  correo: 6,
  modalidad: 9,
  disponibilidad: 10,
  drive: 11,
};

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { email } = req.query || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro email.' });
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
        range: `'${SHEET_NAME}'!A:L`,
      });
      filas = resp.data.values || [];
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: `No se pudo leer la base de datos de clientes (${e.message}). Revisa que la cuenta de servicio tenga acceso a ese Sheet.`,
      });
    }

    const emailBuscado = email.trim().toLowerCase();
    const fila = filas.find(f => (f[COL.correo] || '').trim().toLowerCase() === emailBuscado);

    if (!fila) {
      return res.status(404).json({ success: false, error: 'No hemos encontrado ninguna cuenta de cliente con ese email.' });
    }

    const estado = (fila[COL.estado] || '').trim();
    if (estado && estado.toLowerCase() !== 'activo') {
      return res.status(403).json({
        success: false,
        error: `Tu cuenta de cliente existe pero no está activa (estado: "${estado}"). Contacta con tu entrenador.`,
      });
    }

    const nombre = (fila[COL.nombre] || '').trim();
    const apellidos = (fila[COL.apellidos] || '').trim();

    res.status(200).json({
      success: true,
      cliente: {
        nombre,
        apellidos,
        nombreCompleto: [nombre, apellidos].filter(Boolean).join(' '),
        email: (fila[COL.correo] || '').trim(),
        modalidad: (fila[COL.modalidad] || '').trim(),
        disponibilidad: (fila[COL.disponibilidad] || '').trim(),
        drive: (fila[COL.drive] || '').trim(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
