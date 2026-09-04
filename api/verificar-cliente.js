const { google } = require('googleapis');
const { crearToken } = require('../libs/sesion-cliente.js');

// Google Sheet DISTINTO al de sesiones — es el formulario de alta de clientes
// ("Base de datos clientes"), con una fila por cliente.
const SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
const SHEET_NAME = 'Respuestas de formulario 1';

// Mismo Client ID que usa login.html en el botón de Google Sign-In — hace
// falta aquí para comprobar que un idToken fue emitido de verdad para nuestra
// app (campo "aud" del token) y no para otra.
const GOOGLE_CLIENT_ID = '750960934789-afud0r9hmq7fe700okgu0o0cer0cih1q.apps.googleusercontent.com';

// Verifica el idToken de Google contra el propio Google (tokeninfo) — así la
// firma la comprueba Google, no nosotros. Si es válido y es de nuestra app,
// devuelve el correo real y verificado; si no, null.
async function correoVerificadoDesdeIdToken(idToken) {
  if (!idToken) return null;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!resp.ok) return null;
    const payload = await resp.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;
    if (!payload.email || payload.email_verified !== 'true') return null;
    return payload.email;
  } catch (e) {
    return null;
  }
}

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

async function buscarFilaCliente(sheets, emailBuscado) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_NAME}'!A:L`,
  });
  const filas = resp.data.values || [];
  return filas.find(f => (f[COL.correo] || '').trim().toLowerCase() === emailBuscado);
}

function clienteDesdeFila(fila) {
  const nombre = (fila[COL.nombre] || '').trim();
  const apellidos = (fila[COL.apellidos] || '').trim();
  return {
    nombre,
    apellidos,
    nombreCompleto: [nombre, apellidos].filter(Boolean).join(' '),
    email: (fila[COL.correo] || '').trim(),
    modalidad: (fila[COL.modalidad] || '').trim(),
    disponibilidad: (fila[COL.disponibilidad] || '').trim(),
    drive: (fila[COL.drive] || '').trim(),
  };
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

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // POST — login real: recibe el idToken crudo de Google (no un correo
    // suelto), lo verifica contra el propio Google, y si el correo
    // verificado corresponde a un cliente activo, emite el token de sesión
    // propio (libs/sesion-cliente.js) que a partir de ahora exigen todas las
    // páginas y endpoints de cliente.
    if (req.method === 'POST') {
      const { idToken } = req.body || {};
      const emailVerificado = await correoVerificadoDesdeIdToken(idToken);
      if (!emailVerificado) {
        return res.status(401).json({ success: false, error: 'No se pudo verificar tu inicio de sesión con Google. Vuelve a intentarlo.' });
      }

      let fila;
      try {
        fila = await buscarFilaCliente(sheets, emailVerificado.trim().toLowerCase());
      } catch (e) {
        return res.status(500).json({
          success: false,
          error: `No se pudo leer la base de datos de clientes (${e.message}). Revisa que la cuenta de servicio tenga acceso a ese Sheet.`,
        });
      }
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

      return res.status(200).json({
        success: true,
        cliente: clienteDesdeFila(fila),
        token: crearToken(emailVerificado),
      });
    }

    // GET — consulta de datos básicos por correo (sin emitir token). La usan
    // páginas que ya han pasado su propia comprobación de sesión antes de
    // llegar aquí; no sirve por sí sola para autenticar a nadie.
    const { email } = req.query || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro email.' });
    }

    let fila;
    try {
      fila = await buscarFilaCliente(sheets, email.trim().toLowerCase());
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: `No se pudo leer la base de datos de clientes (${e.message}). Revisa que la cuenta de servicio tenga acceso a ese Sheet.`,
      });
    }

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

    res.status(200).json({ success: true, cliente: clienteDesdeFila(fila) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
