const { google } = require('googleapis');

// Cliente de Sheets autenticado, cacheado por juego de scopes — antes cada
// archivo de api/ creaba una GoogleAuth nueva y llamaba a getClient() en
// CADA petición, tirando a la basura cualquier caché interna de token de una
// llamada a la siguiente. Cada función serverless de Vercel mantiene su
// propio módulo cargado mientras la instancia siga "caliente" (invocaciones
// seguidas sin arranque en frío), así que memorizar aquí el cliente ya
// autenticado evita repetir el intercambio de token con Google en cada
// petición que caiga en esa misma instancia — solo hace falta volver a
// autenticar en un arranque en frío nuevo.
const cachePorScopes = new Map();

function authSheets(scopes) {
  const clave = scopes.join(',');
  if (!cachePorScopes.has(clave)) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      },
      scopes,
    });
    const promesa = auth.getClient().then(authClient => google.sheets({ version: 'v4', auth: authClient }));
    // Si la autenticación falla (p.ej. un corte de red puntual), no se deja
    // la promesa rota en caché — si no, esa instancia calentita quedaría
    // rota hasta el próximo arranque en frío. Se saca del caché para que la
    // siguiente llamada lo vuelva a intentar desde cero.
    promesa.catch(() => cachePorScopes.delete(clave));
    cachePorScopes.set(clave, promesa);
  }
  return cachePorScopes.get(clave);
}

const SCOPE_LECTURA_ESCRITURA = ['https://www.googleapis.com/auth/spreadsheets'];
const SCOPE_SOLO_LECTURA = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

module.exports = { authSheets, SCOPE_LECTURA_ESCRITURA, SCOPE_SOLO_LECTURA };
