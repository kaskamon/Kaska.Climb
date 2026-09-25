// Portero de las herramientas del entrenador (Semanas, Sesiones, Clientes,
// Seguimiento, Macrociclos, Batería test, index). Pide usuario/contraseña con
// el popup nativo del navegador (HTTP Basic Auth) antes de servir esas
// páginas. Las páginas de cliente/, login.html, alta.html, libs/ y api/
// quedan fuera porque las usan clientes reales (o clientes nuevos que aún
// no existen en el Sheet) sin fricción.
//
// La contraseña vive solo en Vercel (variables de entorno TRAINER_USER /
// TRAINER_PASS), nunca en este archivo ni en el repo.

const RUTAS_PUBLICAS = [
  '/login.html',
  '/alta.html',
  '/privacidad.html',
  '/responsabilidad.html',
  '/google2905be849446465b.html',
  '/manifest.json',
  '/manifest-cliente.json',
  '/sw.js',
  '/robots.txt',
  '/logo-192.png',
  '/logo-512.png',
  '/logo-fondo.webp',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
];

const MAX_FALLOS = 5;
const VENTANA_MS = 10 * 60 * 1000;
const fallos = new Map(); // ip -> { cuenta, desde }

function ipDe(request) {
  const xff = request.headers.get('x-forwarded-for');
  return xff ? xff.split(',')[0].trim() : (request.headers.get('x-real-ip') || 'desconocida');
}
function estaBloqueada(ip) {
  const r = fallos.get(ip);
  if (!r) return false;
  if (Date.now() - r.desde > VENTANA_MS) { fallos.delete(ip); return false; }
  return r.cuenta >= MAX_FALLOS;
}
function registrarFallo(ip) {
  const ahora = Date.now();
  if (fallos.size > 500) {
    fallos.forEach((r, k) => { if (ahora - r.desde > VENTANA_MS) fallos.delete(k); });
  }
  const r = fallos.get(ip);
  if (!r || ahora - r.desde > VENTANA_MS) fallos.set(ip, { cuenta: 1, desde: ahora });
  else r.cuenta++;
}

export default function middleware(request) {
  const { pathname } = new URL(request.url);

  const esPublica =
    pathname.startsWith('/api/') ||
    pathname.startsWith('/cliente/') ||
    pathname.startsWith('/libs/') ||
    RUTAS_PUBLICAS.includes(pathname);

  if (esPublica) return;

  const cabecera = request.headers.get('authorization');
  if (cabecera && cabecera.startsWith('Basic ')) {
    // Tras MAX_FALLOS fallos desde una misma IP, esa IP queda bloqueada
    // VENTANA_MS (aunque acierte a partir de ahí, si no seguiría pudiendo
    // adivinar). Contador en memoria por instancia — no es un límite
    // distribuido perfecto (se resetea en un arranque en frío y cada
    // instancia cuenta aparte), pero frena la fuerza bruta sostenida.
    // libs/sesion-cliente.js lleva la misma lógica para /api/ (otro runtime).
    const ip = ipDe(request);
    if (estaBloqueada(ip)) {
      return new Response('Demasiados intentos fallidos — espera 10 minutos antes de volver a probar.', {
        status: 429,
        headers: { 'Retry-After': '600' },
      });
    }

    // Solo el primer ":" separa usuario de clave — con split(':') una
    // clave con ":" dentro nunca coincidía, y "usuario:clave:cualquiercosa"
    // sí colaba (se quedaba con el segundo trozo y tiraba el resto).
    let correcto = false;
    try {
      const credenciales = atob(cabecera.slice(6));
      const i = credenciales.indexOf(':');
      const usuario = credenciales.slice(0, i);
      const clave = credenciales.slice(i + 1);
      correcto = i !== -1 && !!process.env.TRAINER_USER && !!process.env.TRAINER_PASS
        && usuario === process.env.TRAINER_USER && clave === process.env.TRAINER_PASS;
    } catch (e) {
      correcto = false; // base64 inválido: cuenta como intento fallido
    }
    if (correcto) {
      fallos.delete(ip);
      return;
    }
    registrarFallo(ip);
  }

  return new Response('Acceso restringido — zona de entrenador.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Kaska.Climb"' },
  });
}
