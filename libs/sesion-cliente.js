const crypto = require('crypto');

// Token de sesión propio del cliente — firmado con HMAC (nada que ver con el
// JWT corto de Google, que caduca en ~1h; este lo controlamos nosotros y
// dura semanas, para no obligar a reiniciar sesión cada rato). Formato:
// base64url(correo).base64url(caducidadUnix).firmaHex
//
// Se genera UNA vez, justo después de que api/verificar-cliente.js confirme
// con el JWT de Google que el correo es real y existe en la base de
// clientes (ver ese archivo). A partir de ahí, cada página de cliente y
// cada endpoint que sirva sus datos exige y comprueba este token — así ya
// no basta con conocer el correo de alguien para ver su página, hace falta
// haber pasado por el login de Google de verdad.
const DURACION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function desdeBase64url(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}
function firmar(parte1, parte2) {
  return crypto.createHmac('sha256', process.env.SESION_CLIENTE_SECRET || '')
    .update(parte1 + '.' + parte2).digest('hex');
}

function crearToken(correo) {
  const p1 = base64url(correo.trim().toLowerCase());
  const p2 = base64url(String(Date.now() + DURACION_MS));
  return `${p1}.${p2}.${firmar(p1, p2)}`;
}

// Devuelve { ok:true, correo } si el token es válido, no ha caducado, y (si
// se pasa correoEsperado) corresponde exactamente a ese cliente. Si no,
// { ok:false, error }.
function verificarToken(token, correoEsperado) {
  if (!process.env.SESION_CLIENTE_SECRET) {
    return { ok: false, error: 'Falta la variable de entorno SESION_CLIENTE_SECRET en Vercel.' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Sesión no válida — vuelve a iniciar sesión.' };
  }
  const partes = token.split('.');
  if (partes.length !== 3) return { ok: false, error: 'Sesión no válida — vuelve a iniciar sesión.' };
  const [p1, p2, firma] = partes;

  const firmaEsperada = firmar(p1, p2);
  const bufA = Buffer.from(firma, 'hex');
  const bufB = Buffer.from(firmaEsperada, 'hex');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return { ok: false, error: 'Sesión no válida — vuelve a iniciar sesión.' };
  }

  const caduca = Number(desdeBase64url(p2));
  if (!caduca || Date.now() > caduca) {
    return { ok: false, error: 'Tu sesión ha caducado — vuelve a iniciar sesión.' };
  }

  const correo = desdeBase64url(p1);
  if (correoEsperado && correo !== correoEsperado.trim().toLowerCase()) {
    return { ok: false, error: 'Esta sesión no corresponde a este cliente.' };
  }
  return { ok: true, correo };
}

// Varios endpoints los usa tanto el cliente (con su token) como el propio
// entrenador desde sus herramientas (protegidas con la contraseña de
// middleware.js — Basic Auth, que el navegador reenvía solo con pedirlo en
// cada fetch() del mismo origen). Vale cualquiera de las dos; sin ninguna,
// se rechaza. token puede venir de query, body o cabecera Authorization
// "Bearer <token>".
function verificarAccesoCliente(req, correoEsperado) {
  const cabecera = req.headers && req.headers.authorization;
  if (cabecera && cabecera.startsWith('Basic ')) {
    try {
      const [usuario, clave] = Buffer.from(cabecera.slice(6), 'base64').toString('utf8').split(':');
      if (usuario === process.env.TRAINER_USER && clave === process.env.TRAINER_PASS) {
        return { ok: true, esEntrenador: true };
      }
    } catch (e) { /* cae al intento por token */ }
  }

  let token = (req.query && req.query.token) || (req.body && req.body.token);
  if (!token && cabecera && cabecera.startsWith('Bearer ')) token = cabecera.slice(7);

  const resultado = verificarToken(token, correoEsperado);
  if (!resultado.ok) return { ok: false, error: resultado.error };
  return { ok: true, esEntrenador: false, correo: resultado.correo };
}

// Para acciones que solo debe poder hacer el entrenador (p.ej. publicar un
// macrociclo) — exige la contraseña de middleware.js, un token de cliente
// nunca vale aquí.
function verificarEntrenador(req) {
  const cabecera = req.headers && req.headers.authorization;
  if (cabecera && cabecera.startsWith('Basic ')) {
    try {
      const [usuario, clave] = Buffer.from(cabecera.slice(6), 'base64').toString('utf8').split(':');
      if (usuario === process.env.TRAINER_USER && clave === process.env.TRAINER_PASS) {
        return { ok: true };
      }
    } catch (e) { /* cae al error de abajo */ }
  }
  return { ok: false, error: 'Esta acción es solo para el entrenador.' };
}

module.exports = { crearToken, verificarToken, verificarAccesoCliente, verificarEntrenador };
