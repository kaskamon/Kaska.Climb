/**
 * Sesión de cliente en el navegador — el token que emite api/verificar-cliente.js
 * (POST, tras comprobar el login de Google de verdad) vive aquí, y cada
 * página de cliente/ lo exige antes de enseñar nada y lo manda en cada
 * fetch a un endpoint que sirva datos de ese cliente.
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

// Exige que haya una sesión guardada Y que sea la de este correo en
// concreto — si no, manda a login.html en vez de dejar ver nada. Se llama
// nada más conocer el CLIENTE de la URL, antes de pedir ningún dato.
function exigirSesionCliente(correoEsperado){
  const sesion = obtenerSesionCliente();
  if(!sesion || sesion.email.trim().toLowerCase() !== (correoEsperado || '').trim().toLowerCase()){
    window.location.href = '/login.html';
    return null;
  }
  return sesion;
}
