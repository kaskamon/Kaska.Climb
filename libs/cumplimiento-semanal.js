/**
 * Motor de puntuación del "cumplimiento semanal" del cliente — diseño
 * cerrado con el usuario el 30/09/2026 (ver memoria de proyecto
 * proyecto_cumplimiento_semanal.md). Puro (sin Sheets ni red) para poder
 * usarse igual desde el cron de cierre de semana (api/macrociclo.js) y desde
 * la lectura en vivo de la semana en curso.
 *
 * Cada sesión "roco" reparte 3 puntos como máximo: Suspensiones=1.5,
 * Campus=0.5, Integrado=1 — salvo AERO y TAPERING, que no tienen Campus
 * (máximo 2.5). Cada sesión GYM (GYM-FMAX/GYM-ANTAGONISTAS) vale 1 punto.
 * ROCA/DESCANSO no tienen nada que puntuar en la parte roco (0 posible).
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.CUMPLIMIENTO_SEMANAL = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const PESO_PRINCIPAL = 1.5;
  const PESO_SECUNDARIO = 0.5;
  const PESO_INTEGRADO = 1;
  const PESO_GYM = 1;

  // Índices dentro de COLUMNS[mesociclo].campos (o del array `campos` que ya
  // devuelve api/obtener-historial.js) que corresponden a cada categoría.
  // DESOX tiene 2 campos "integrado" porque Traves-sin-sueltas y Multibloque
  // son alternativas (una semana solo trae UNA de las dos) — cualquiera de
  // las dos con dato ya da el punto completo, no hace falta que estén las 2.
  const CATEGORIAS_CAMPOS_ROCO = {
    FMAX:     { principal: [0], secundario: [1], integrado: [2] },
    REOX:     { principal: [0], secundario: [1], integrado: [2] },
    DESOX:    { principal: [0], secundario: [1], integrado: [2, 3] },
    AERO:     { principal: [0], secundario: [],  integrado: [1] },
    TAPERING: { principal: [0], secundario: [],  integrado: [1] },
  };

  // Mesociclos "roco" que sí tienen algo que puntuar en la parte analítica/
  // integrada. ROCA y DESCANSO se quedan fuera (0 posible ahí) — son semanas
  // de descanso/roca libre por diseño, no hay estructura real que medir.
  const MESOCICLOS_ROCO_PUNTUABLES = Object.keys(CATEGORIAS_CAMPOS_ROCO);

  const MESOCICLOS_GYM = ['GYM-FMAX', 'GYM-ANTAGONISTAS'];

  function tieneValor(v) {
    return v !== undefined && v !== null && v !== '';
  }

  function tieneAlguno(camposValores, idxs) {
    return idxs.some(i => tieneValor(camposValores[i]));
  }

  // camposValores: array plano de valores (mismo orden que COLUMNS[meso].campos),
  // como ya devuelve api/obtener-historial.js en su campo `campos`.
  function puntosSesionRoco(mesociclo, camposValores) {
    const grupo = CATEGORIAS_CAMPOS_ROCO[mesociclo];
    if (!grupo) return { puntos: 0, posible: 0 };
    const valores = camposValores || [];
    let puntos = 0, posible = 0;
    if (grupo.principal.length) {
      posible += PESO_PRINCIPAL;
      if (tieneAlguno(valores, grupo.principal)) puntos += PESO_PRINCIPAL;
    }
    if (grupo.secundario.length) {
      posible += PESO_SECUNDARIO;
      if (tieneAlguno(valores, grupo.secundario)) puntos += PESO_SECUNDARIO;
    }
    if (grupo.integrado.length) {
      posible += PESO_INTEGRADO;
      if (tieneAlguno(valores, grupo.integrado)) puntos += PESO_INTEGRADO;
    }
    return { puntos, posible };
  }

  // Igual que puntosSesionRoco, pero como 3 booleanos (para pintar los
  // "cuadraditos" susp/campus/integrado de la tira de sesiones en el front,
  // sin duplicar ahí la lógica de categorías). Una categoría que ese
  // mesociclo no tiene (p.ej. "secundario" en AERO/TAPERING) sale null, no
  // false, para poder distinguir "no aplica" de "no se hizo".
  function detalleSesionRoco(mesociclo, camposValores) {
    const grupo = CATEGORIAS_CAMPOS_ROCO[mesociclo];
    if (!grupo) return { principal: null, secundario: null, integrado: null };
    const valores = camposValores || [];
    return {
      principal: grupo.principal.length ? tieneAlguno(valores, grupo.principal) : null,
      secundario: grupo.secundario.length ? tieneAlguno(valores, grupo.secundario) : null,
      integrado: grupo.integrado.length ? tieneAlguno(valores, grupo.integrado) : null,
    };
  }

  // sesionesRoco: [{ mesociclo, entrenada, campos }] — una por sesión roco
  // PROGRAMADA esa semana (si no se entrenó/bloqueada, campos viene vacío y
  // puntosSesionRoco ya da 0 puntos sin más).
  // sesionesGym: [{ entrenada }] — una por sesión GYM programada esa semana.
  // Semanas retroactivas (antes de que exista el registro real de lo
  // programado): pasar sesionesRoco/sesionesGym ya construidas con la
  // plantilla asumida 2+1 (ver construirProgramacionAsumida2Mas1).
  function calcularCumplimientoSemana(sesionesRoco, sesionesGym) {
    let puntos = 0, posible = 0;
    (sesionesRoco || []).forEach(s => {
      const r = puntosSesionRoco(s.mesociclo, s.campos);
      posible += r.posible;
      if (s.entrenada) puntos += r.puntos;
    });
    (sesionesGym || []).forEach(s => {
      posible += PESO_GYM;
      if (s.entrenada) puntos += PESO_GYM;
    });
    // Tope en 100% — una sesión extra no programada nunca infla el % (no
    // debería poder pasar con este cómputo, que solo mira sesiones
    // programadas, pero el tope se deja explícito por si acaso).
    if (posible > 0 && puntos > posible) puntos = posible;
    const porcentaje = posible > 0 ? Math.round((puntos / posible) * 1000) / 10 : null;
    return { puntos, posible, porcentaje };
  }

  // Plantilla asumida para semanas históricas sin registro real de lo
  // programado (antes de que exista Cumplimiento_Semanal): 2 roco del
  // mesociclo activo esa semana + 1 gym, con los mismos datos de
  // Respuestas de formulario 1 que ya existan para esas fechas.
  function construirProgramacionAsumida2Mas1(mesociclo) {
    return {
      sesionesRoco: MESOCICLOS_ROCO_PUNTUABLES.includes(mesociclo) ? [{ mesociclo }, { mesociclo }] : [],
      sesionesGym: [{}],
    };
  }

  return {
    PESO_PRINCIPAL,
    PESO_SECUNDARIO,
    PESO_INTEGRADO,
    PESO_GYM,
    CATEGORIAS_CAMPOS_ROCO,
    MESOCICLOS_ROCO_PUNTUABLES,
    MESOCICLOS_GYM,
    puntosSesionRoco,
    detalleSesionRoco,
    calcularCumplimientoSemana,
    construirProgramacionAsumida2Mas1,
  };
});
