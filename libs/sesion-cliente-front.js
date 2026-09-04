/**
 * Sesión de cliente en el navegador — el token que emite api/verificar-cliente.js
 * (POST, tras comprobar el login de Google de verdad) vive aquí.
 *
 * OJO: el entrenador también puede estar viendo la página de OTRO cliente
 * (botón "Ver como cliente" de Clientes.html) — en ese caso la sesión
 * guardada es la suya propia, no la del cliente que está mirando, y aun así
 * debe poder ver sus datos (autenticado por su contraseña de entrenador,
 * que el navegador ya adjunta solo en cada fetch del mismo origen). Por eso
 * esto NO bloquea nada por sí mismo — cada endpoint de datos es quien de
 * verdad decide (acepta el token del cliente exacto O la contraseña de
 * entrenador); aquí solo se prepara el token a mandar, y se redirige a
 * login.html únicamente cuando el propio servidor responde que no autoriza.
 */
const CLAVE_SESION_CLIENTE = 'kaska_sesion_cliente';

function obtenerSesionCliente(){
  try{
    const guardado = localStorage.getItem(CLAVE_SESION_CLIENTE);
    if(!guardado) return null;
    const datos = JSON.parse(guardado);
    if(!datos || !datos.email || !datos.token) return null;
    return datos;
  }catch(e){ return null; }
}

// Token a mandar en las peticiones de esta página. Si la sesión guardada es
// la de este mismo correo, se manda su token; si no (sesión de otra
// persona, o ninguna), se manda vacío — el servidor decide con lo que
// tenga (token vacío nunca es válido por sí solo, pero la Basic Auth del
// entrenador sí puede colar igualmente).
function tokenParaCliente(correoEsperado){
  const sesion = obtenerSesionCliente();
  if(sesion && sesion.email.trim().toLowerCase() === (correoEsperado || '').trim().toLowerCase()){
    return sesion.token;
  }
  return '';
}

// Llamar cuando una petición a un endpoint de datos de cliente responde 401
// (ni el token del cliente ni la contraseña de entrenador valían) — a
// login.html, que es la única situación real en la que hace falta volver a
// identificarse.
function manejarSesionInvalida(){
  window.location.href = '/login.html';
}
