const { clienteOAuth } = require('../libs/google-oauth-entrenador.js');

// Paso 2 (y último) del alta de una sola vez: Google vuelve aquí con un
// "code" tras el consentimiento. Lo cambiamos por los tokens reales y
// mostramos el refresh_token en pantalla — no hay ningún sitio donde
// guardarlo solo desde el backend (Vercel no tiene almacenamiento propio
// escribible), así que el propio entrenador lo copia a mano a una variable
// de entorno nueva (GOOGLE_TRAINER_REFRESH_TOKEN) en Vercel, una sola vez.
// Después de eso, este endpoint no hace falta volver a usarlo salvo que se
// revoque el acceso.
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

module.exports = async (req, res) => {
  const { code, error } = req.query || {};

  if (error) {
    res.status(400).send(paginaResultado('Cancelado', `<h1>Consentimiento cancelado</h1><p>Google devolvió: <code>${error}</code>. Vuelve a intentarlo desde /api/drive-oauth-inicio.</p>`));
    return;
  }
  if (!code) {
    res.status(400).send(paginaResultado('Falta el código', '<h1>Falta el parámetro "code"</h1><p>Entra por /api/drive-oauth-inicio, no directamente aquí.</p>'));
    return;
  }
  if (!process.env.GOOGLE_CLIENT_SECRET) {
    res.status(500).send(paginaResultado('Falta configuración', '<h1>Falta GOOGLE_CLIENT_SECRET en Vercel</h1><p>Cópialo desde Google Cloud Console → APIs y servicios → Credenciales → tu Client ID → Client Secret, y añádelo como variable de entorno antes de repetir esto.</p>'));
    return;
  }

  try {
    const oauth2Client = clienteOAuth();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.status(200).send(paginaResultado('Sin refresh token', `
        <h1>Google no ha mandado un refresh token esta vez</h1>
        <div class="aviso">Suele pasar si ya habías dado acceso antes. Ve a
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>,
        quita el acceso de "Kaska.Climb", y vuelve a entrar por
        <a href="/api/drive-oauth-inicio">/api/drive-oauth-inicio</a>.</div>`));
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
};
