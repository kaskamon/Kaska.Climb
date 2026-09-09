const { clienteOAuth } = require('../libs/google-oauth-entrenador.js');

// Paso 1 del alta de una sola vez: redirige a la pantalla de consentimiento
// de Google para que el entrenador conecte su propia cuenta (no la cuenta de
// servicio) para Drive. Protegido con la misma contraseña del área de
// entrenador (ver middleware.js — esta ruta está explícitamente excluida de
// la lista de rutas "libres" de /api/, así que exige el popup de usuario y
// contraseña igual que Semanas.html).
//
// access_type=offline + prompt=consent: sin esto Google no vuelve a mandar
// el refresh_token si ya se había dado consentimiento antes (y sin
// refresh_token no hay forma de usar esto desde el backend sin que el
// entrenador tenga que volver a iniciar sesión cada vez).
module.exports = async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_SECRET) {
    res.status(500).send('Falta GOOGLE_CLIENT_SECRET en Vercel — cópialo desde Google Cloud Console → APIs y servicios → Credenciales → tu Client ID → Client Secret, y añádelo antes de continuar.');
    return;
  }
  const oauth2Client = clienteOAuth();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive'],
  });
  res.writeHead(302, { Location: url });
  res.end();
};
