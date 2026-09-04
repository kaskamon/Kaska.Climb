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
  '/manifest.json',
  '/manifest-cliente.json',
  '/sw.js',
  '/robots.txt',
  '/logo.png',
  '/logo-192.png',
  '/logo-512.png',
];

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
    const [usuario, clave] = atob(cabecera.slice(6)).split(':');
    if (usuario === process.env.TRAINER_USER && clave === process.env.TRAINER_PASS) {
      return;
    }
  }

  return new Response('Acceso restringido — zona de entrenador.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Kaska.Climb"' },
  });
}
