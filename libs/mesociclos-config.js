/**
 * Fuente única de verdad sobre los 6 mesociclos — la usan tanto el backend
 * (api/enviar-sesion.js, api/obtener-historial.js) como el motor genérico de
 * sesión (cliente/sesion.html), para no duplicar el mapeo en varios sitios.
 *
 * Cargable desde Node (require) y desde el navegador (<script src="...">, deja
 * window.MESOCICLOS_CONFIG).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MESOCICLOS_CONFIG = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Mapeo de columnas reales en 'Respuestas de formulario 1' (A=0, B=1, ...).
  // Igual que el objeto MESOCICLOS que ya vivía dentro de enviar-sesion.js —
  // movido aquí para que obtener-historial.js pueda leer los mismos índices
  // sin duplicar el mapeo.
  var COLUMNS = {
    FMAX:  { pfInicial: 6,  fmaxDer: 7,  fmaxIzq: 8,  campos: [9, 10, 11],      pfFinal: 12 }, // SuspMax, Saltos a regleta, Boulder max
    REOX:  { pfInicial: 13, fmaxDer: 14, fmaxIzq: 15, campos: [16, 17, 18],     pfFinal: 19 }, // SuspInt OT, Campus HMH, Travesías con sueltas
    DESOX: { pfInicial: 20, fmaxDer: 21, fmaxIzq: 22, campos: [23, 24, 25, 26], pfFinal: 27 }, // SuspSub, Campus McClure, Travesías sin sueltas, Multibloque
    AERO:  { pfInicial: 28, fmaxDer: 29, fmaxIzq: 30, campos: [31, 32] },                      // SuspInt CF, Escalada continua — sin PFfinal
    'GYM-FMAX':         { unico: 4 },  // E - Dominadas con lastre
    'GYM-ANTAGONISTAS': {},            // sin columnas de datos, solo queda registrada la fila
  };

  // Qué "parte" del JSON de sesión (el mismo formato que exporta Sesiones.html:
  // partes -> bloque_ejercicios{titulo, descripcion, ejercicios[]} / cabecera_separadora)
  // lleva caja de datos, y a qué slot del payload de /api/enviar-sesion corresponde.
  //
  // `match` se compara contra el `titulo` del bloque_ejercicios, sin mayúsculas
  // ni espacios sobrantes. El orden de `campos` en cada mesociclo debe coincidir
  // EXACTAMENTE con el orden de columnas de COLUMNS[mesociclo].campos.
  var FIELD_MAP = {
    FMAX: {
      pfInicial: { match: 'Test PFinicial' },
      fmaxTest:  { match: 'Test Fmax 5"' },
      fmaxReferenceBlock: { match: 'Activación muscular analítica (dedos)' },
      campos: [
        { match: 'SuspMax',      id: 'susp-max',       label: 'Series completadas' },
        { match: 'Campus Board', id: 'saltos-regleta', label: 'Series completadas' },
        { match: 'Boulder Max',  id: 'boulder-max',    label: 'Nº de pegues totales' },
      ],
      pfFinal: { match: 'Test PFfinal' },
      umbralControl: 7,
      umbralIntegrado: 15,
    },
    REOX: {
      pfInicial: { match: 'Test PFinicial' },
      fmaxTest:  { match: 'Test Fmax 5"' },
      fmaxReferenceBlock: { match: 'Activación muscular analítica (dedos)' },
      campos: [
        { match: 'SuspInt (OT)', id: 'susp-int',   label: 'Series completadas' },
        { match: 'Campus Board', id: 'campus-hmh', label: 'Series completadas' },
        { match: 'Traves con sueltas', id: 'travesias', label: 'Nº de pegues totales' },
      ],
      pfFinal: { match: 'Test PFfinal' },
      umbralControl: 7,
      umbralIntegrado: 15,
    },
    DESOX: {
      pfInicial: { match: 'Test PFinicial' },
      fmaxTest:  { match: 'Test Fmax 5"' },
      fmaxReferenceBlock: { match: 'Activación muscular analítica (dedos)' },
      campos: [
        // Traves sin sueltas y Multibloque son alternativas — una semana solo
        // vendrá UNA de las dos en el JSON. El motor solo pinta y exige la que
        // encuentre; si falta una, su hueco en "campos" se envía vacío.
        { match: 'SuspSub (OT)',       id: 'susp-sub',       label: 'Series completadas' },
        { match: 'Campus Board',       id: 'campus-mcclure', label: 'Series completadas' },
        { match: 'Traves sin sueltas', id: 'travesias',      label: 'Nº de pegues totales' },
        { match: 'Multibloque',        id: 'multibloque',    label: 'Nº de bloques completados' },
      ],
      pfFinal: { match: 'Test PFfinal' },
      umbralControl: 7,
      umbralIntegrado: 15,
    },
    AERO: {
      pfInicial: { match: 'Test PFinicial' },
      fmaxTest:  { match: 'Test Fmax 5"' },
      fmaxReferenceBlock: { match: 'Activación muscular analítica (dedos)' },
      campos: [
        { match: 'SuspInt (CF)',      id: 'susp-cf',  label: 'Series completadas' },
        { match: 'Escalada continua', id: 'escalada', label: 'Tiempo escalado', tipo: 'tiempo' },
      ],
      pfFinal: null, // AERO no mide Test PFfinal
      umbralControl: 7,
    },
    'GYM-FMAX': {
      // Dominadas con lastre es el único ejercicio con dato real dentro del
      // bloque "Fmax tracción" (que también incluye Bloqueos, sin dato).
      unico: { match: 'Fmax tracción', id: 'dominadas', label: 'Series completadas (Dominadas con lastre)' },
    },
    'GYM-ANTAGONISTAS': {},
  };

  // Título visible en la cabecera de la sesión — el mesociclo interno (clave del
  // payload / de COLUMNS) no siempre coincide con el rótulo que ve el cliente.
  var TITULOS = {
    FMAX: 'FMAX (ROCO)',
    REOX: 'REOX (ROCO)',
    DESOX: 'DESOX/ANAE (ROCO)',
    AERO: 'AERO (ROCO)',
    'GYM-FMAX': 'GYM-FMAX',
    'GYM-ANTAGONISTAS': 'GYM-ANTAGONISTAS',
  };

  return { COLUMNS: COLUMNS, FIELD_MAP: FIELD_MAP, TITULOS: TITULOS };
});
