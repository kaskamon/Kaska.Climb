// Puerto a Node de la misma lógica que ya usa Semanas.html (función
// calcularFaseYSemana, cliente) para saber qué fase/mesociclo real le toca a
// una semana concreta de un macrociclo. Se porta aquí, en vez de reimplementar
// algo parecido, para que el cálculo del servidor (aviso de "semana sin
// publicar" y la rejilla de Programación) coincida siempre con lo que ve el
// entrenador al publicar en Semanas.html.

// Macrociclos.html guarda cada bloque con una clave de fase en minúsculas
// (fmax/desox/reox/aero/tap) distinta de la clave de mesociclo en mayúsculas
// que usa el resto de la app (FMAX/DESOX/REOX/AERO/TAPERING).
const FASE_A_MESOCICLO = { fmax: 'FMAX', desox: 'DESOX', reox: 'REOX', aero: 'AERO', tap: 'TAPERING' };

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}

function formatFechaDDMMYYYY(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function lunesDe(date) {
  const diaSemana = date.getDay(); // 0=domingo .. 6=sábado
  const offsetALunes = diaSemana === 0 ? -6 : 1 - diaSemana;
  const lunes = new Date(date);
  lunes.setDate(lunes.getDate() + offsetALunes);
  lunes.setHours(0, 0, 0, 0);
  return lunes;
}

// Dado el macrociclo real de un cliente (inicio "yyyy-mm-dd" + bloques
// [{fase,semanas}]) y el lunes de una semana concreta (dd/mm/aaaa), calcula
// en qué bloque cae esa semana y qué número de semana es dentro de ese
// bloque. Devuelve fueraDeRango si la fecha es anterior al inicio o
// posterior al final del macrociclo publicado. Idéntico al de Semanas.html.
function calcularFaseYSemana(inicioISO, bloques, fechaLunesDDMMYYYY) {
  const [yI, mI, dI] = (inicioISO || '').split('-').map(Number);
  const inicio = new Date(yI, mI - 1, dI);
  const lunes = parseFechaDDMMYYYY(fechaLunesDDMMYYYY);

  const diffDias = Math.round((lunes - inicio) / 86400000);
  if (diffDias < 0) return { fueraDeRango: true, motivo: 'antes' };

  const semanaGlobal = Math.floor(diffDias / 7) + 1;
  let acumulado = 0;
  const lista = bloques || [];
  for (let idx = 0; idx < lista.length; idx++) {
    const b = lista[idx];
    const semanasBloque = Number(b.semanas) || 0;
    if (semanaGlobal <= acumulado + semanasBloque) {
      const mesociclo = FASE_A_MESOCICLO[b.fase] || String(b.fase || '').toUpperCase();
      let origenTapering = null;
      if (mesociclo === 'TAPERING' && idx > 0) {
        const anterior = lista[idx - 1];
        const mesocicloAnterior = FASE_A_MESOCICLO[anterior.fase] || String(anterior.fase || '').toUpperCase();
        if (['FMAX', 'REOX', 'DESOX', 'AERO'].includes(mesocicloAnterior)) origenTapering = mesocicloAnterior;
      }
      return {
        fueraDeRango: false,
        mesociclo,
        origenTapering,
        semanaEnBloque: semanaGlobal - acumulado,
        semanasBloque,
        semanaGlobal,
      };
    }
    acumulado += semanasBloque;
  }
  return { fueraDeRango: true, motivo: 'despues', semanaGlobal, totalSemanas: acumulado };
}

// Desglose completo semana a semana de un macrociclo (semana 1..total),
// usado por la rejilla visual de Programación — la comprobación puntual de
// "solo la semana siguiente" (aviso de sábado/domingo) usa calcularFaseYSemana
// directamente, sin necesitar este desglose entero.
function semanasDelMacrociclo(inicioISO, bloques) {
  const [yI, mI, dI] = (inicioISO || '').split('-').map(Number);
  const inicio = new Date(yI, mI - 1, dI);
  const total = (bloques || []).reduce((s, b) => s + (Number(b.semanas) || 0), 0);

  const semanas = [];
  for (let n = 1; n <= total; n++) {
    const lunes = new Date(inicio);
    lunes.setDate(lunes.getDate() + (n - 1) * 7);
    const fechaLunes = formatFechaDDMMYYYY(lunes);
    const calc = calcularFaseYSemana(inicioISO, bloques, fechaLunes);
    semanas.push({
      semanaGlobal: n,
      fechaLunes,
      mesociclo: calc.fueraDeRango ? null : calc.mesociclo,
      origenTapering: calc.fueraDeRango ? null : calc.origenTapering,
    });
  }
  return { totalSemanas: total, semanas };
}

module.exports = {
  FASE_A_MESOCICLO,
  parseFechaDDMMYYYY,
  formatFechaDDMMYYYY,
  lunesDe,
  calcularFaseYSemana,
  semanasDelMacrociclo,
};
