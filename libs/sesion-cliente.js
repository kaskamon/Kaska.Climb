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

// Cabecera "Authorization: Basic ..." con el usuario/contraseña de entrenador
// (TRAINER_USER / TRAINER_PASS). Solo el primer ":" separa usuario de clave —
// con split(':') una clave con ":" dentro nunca coincidía, y
// "usuario:clave:cualquiercosa" sí colaba. Comparación en tiempo constante.
function iguales(a, b) {
  const bufA = Buffer.from(String(a)), bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Límite de intentos fallidos de la contraseña de entrenador: tras
// MAX_FALLOS_ENTRENADOR fallos desde una misma IP, esa IP queda bloqueada
// VENTANA_FALLOS_MS (aunque acierte a partir de ahí — si no, seguiría
// pudiendo adivinar). Contador en memoria por instancia caliente, igual que
// el del alta pública (api/listar-clientes.js): no es un límite distribuido
// perfecto (se resetea en un arranque en frío y cada instancia concurrente
// cuenta aparte), pero frena de raíz la fuerza bruta sostenida. middleware.js
// (que protege las páginas) lleva su propia copia de esta misma lógica — es
// otro runtime (Edge), no comparte memoria con esto. Los aciertos borran el
// contador, para que un despiste con la clave no acumule.
const MAX_FALLOS_ENTRENADOR = 5;
const VENTANA_FALLOS_MS = 10 * 60 * 1000;
const fallosEntrenador = new Map(); // ip -> { cuenta, desde }

function ipDe(req) {
  const h = (req && req.headers) || {};
  const xff = h['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : String(h['x-real-ip'] || 'desconocida'));
}
function entrenadorBloqueado(ip) {
  const r = fallosEntrenador.get(ip);
  if (!r) return false;
  if (Date.now() - r.desde > VENTANA_FALLOS_MS) { fallosEntrenador.delete(ip); return false; }
  return r.cuenta >= MAX_FALLOS_ENTRENADOR;
}
function registrarFalloEntrenador(ip) {
  const ahora = Date.now();
  if (fallosEntrenador.size > 500) {
    fallosEntrenador.forEach((r, k) => { if (ahora - r.desde > VENTANA_FALLOS_MS) fallosEntrenador.delete(k); });
  }
  const r = fallosEntrenador.get(ip);
  if (!r || ahora - r.desde > VENTANA_FALLOS_MS) fallosEntrenador.set(ip, { cuenta: 1, desde: ahora });
  else r.cuenta++;
}

// Devuelve 'ok' | 'mal' | 'sin' (no hay cabecera Basic, o no está configurado
// TRAINER_USER/TRAINER_PASS: no cuenta como intento) | 'bloqueado'.
function comprobarBasicEntrenador(req) {
  const cabecera = req.headers && req.headers.authorization;
  if (!process.env.TRAINER_USER || !process.env.TRAINER_PASS) return 'sin';
  if (!cabecera || !cabecera.startsWith('Basic ')) return 'sin';
  const ip = ipDe(req);
  if (entrenadorBloqueado(ip)) return 'bloqueado';
  let correcto = false;
  try {
    const credenciales = Buffer.from(cabecera.slice(6), 'base64').toString('utf8');
    const i = credenciales.indexOf(':');
    correcto = i !== -1
      && iguales(credenciales.slice(0, i), process.env.TRAINER_USER)
      && iguales(credenciales.slice(i + 1), process.env.TRAINER_PASS);
  } catch (e) {
    correcto = false;
  }
  if (correcto) { fallosEntrenador.delete(ip); return 'ok'; }
  registrarFalloEntrenador(ip);
  return 'mal';
}

const ERROR_BLOQUEADO = 'Demasiados intentos fallidos — espera 10 minutos antes de volver a probar.';

// Varios endpoints los usa tanto el cliente (con su token) como el propio
// entrenador desde sus herramientas (protegidas con la contraseña de
// middleware.js — Basic Auth, que el navegador reenvía solo con pedirlo en
// cada fetch() del mismo origen). Vale cualquiera de las dos; sin ninguna,
// se rechaza. token puede venir de query, body o cabecera Authorization
// "Bearer <token>".
//
// El token manda siempre que exista: si el propio entrenador entra en su
// área de cliente real desde el mismo dispositivo/navegador donde usa sus
// herramientas, el navegador reenvía igualmente la Basic Auth cacheada junto
// con el token — sin esto se colaría como "vista de entrenador" en su propia
// sesión de cliente. Basic Auth solo decide cuando NO hay token, que es
// justo el caso de "ver como cliente" desde Programación (manda el token
// vacío a propósito).
function verificarAccesoCliente(req, correoEsperado) {
  let token = (req.query && req.query.token) || (req.body && req.body.token);
  const cabecera = req.headers && req.headers.authorization;
  if (!token && cabecera && cabecera.startsWith('Bearer ')) token = cabecera.slice(7);

  if (token) {
    const resultado = verificarToken(token, correoEsperado);
    if (!resultado.ok) return { ok: false, error: resultado.error };
    return { ok: true, esEntrenador: false, correo: resultado.correo };
  }

  const basic = comprobarBasicEntrenador(req);
  if (basic === 'ok') return { ok: true, esEntrenador: true };
  if (basic === 'bloqueado') return { ok: false, bloqueado: true, error: ERROR_BLOQUEADO };

  return { ok: false, error: 'Sesión no válida — vuelve a iniciar sesión.' };
}

// Para acciones que solo debe poder hacer el entrenador (p.ej. publicar un
// macrociclo) — exige la contraseña de middleware.js, un token de cliente
// nunca vale aquí.
function verificarEntrenador(req) {
  const basic = comprobarBasicEntrenador(req);
  if (basic === 'ok') return { ok: true };
  if (basic === 'bloqueado') return { ok: false, bloqueado: true, error: ERROR_BLOQUEADO };
  return { ok: false, error: 'Esta acción es solo para el entrenador.' };
}

module.exports = { crearToken, verificarToken, verificarAccesoCliente, verificarEntrenador };
