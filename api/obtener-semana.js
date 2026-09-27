const { verificarAccesoCliente } = require('../libs/sesion-cliente.js');
const { CATEGORIA_VISUAL } = require('../libs/mesociclos-config.js');
const { authSheets, SCOPE_SOLO_LECTURA } = require('../libs/sheets-auth.js');
const { parseFechaDDMMYYYY, formatFechaDDMMYYYY, lunesDe, calcularFaseYSemana } = require('../libs/planificacion-semanas.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
const SHEET_NAME = 'Sesiones_Programadas';
// Mismo Sheet que gestiona Macrociclos.html (api/macrociclo.js) — se lee aquí
// para recalcular "Semana X/Y" en vivo, ver más abajo.
const MACROCICLOS_SHEET = 'Macrociclos_Cliente';

// El macrociclo más reciente publicado por ese cliente (última fila que
// coincide, igual que api/macrociclo.js:manejarGet) — null si nunca tuvo uno.
function macrocicloMasReciente(filasMacro, cliente) {
  const correoBuscado = cliente.trim().toLowerCase();
  for (let i = filasMacro.length - 1; i >= 0; i--) {
    if ((filasMacro[i][1] || '').trim().toLowerCase() === correoBuscado) {
      try {
        return { inicio: filasMacro[i][3] || '', bloques: JSON.parse(filasMacro[i][5] || '[]') };
      } catch (e) {
        return null; // JSON inválido — se sigue con los valores congelados de la fila publicada
      }
    }
  }
  return null;
}

// Dado cualquier fecha de referencia, devuelve las 7 fechas (dd/mm/aaaa) de esa
// semana, Lunes a Domingo.
function diasDeLaSemana(ref) {
  const lunes = lunesDe(ref);
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(lunes);
    d.setDate(d.getDate() + i);
    dias.push(formatFechaDDMMYYYY(d));
  }
  return dias;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa GET.' });
  }

  try {
    const { cliente, fecha } = req.query || {};
    if (!cliente) {
      return res.status(400).json({ success: false, error: 'Falta el parámetro cliente.' });
    }
    const acceso = verificarAccesoCliente(req, cliente);
    if (!acceso.ok) {
      return res.status(401).json({ success: false, error: acceso.error });
    }

    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }

    const sheets = await authSheets(SCOPE_SOLO_LECTURA);

    let filas, filasMacro;
    try {
      const [respSesiones, respMacro] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:G` }),
        sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${MACROCICLOS_SHEET}'!A:F` }),
      ]);
      filas = respSesiones.data.values || [];
      filasMacro = respMacro.data.values || [];
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: `No se pudo leer la pestaña "${SHEET_NAME}" (${e.message}).`,
      });
    }

    // Sin fecha explícita: usamos el día de la fila más reciente publicada
    // para este cliente (de abajo a arriba) como referencia — así "Cargar
    // último publicado" no depende de que el entrenador escriba antes el
    // lunes de la semana.
    let ref;
    if (fecha) {
      ref = parseFechaDDMMYYYY(fecha) || new Date();
    } else {
      let ultimaFecha = null;
      for (let i = filas.length - 1; i >= 0; i--) {
        if (filas[i][1] === cliente) { ultimaFecha = filas[i][2]; break; }
      }
      ref = (ultimaFecha && parseFechaDDMMYYYY(ultimaFecha)) || new Date();
    }
    const dias = diasDeLaSemana(ref);

    // Para cada (fecha, mesociclo) del cliente en esta semana, nos quedamos con
    // la publicación más reciente (las filas van en orden de inserción, así que
    // sobreescribir según avanzamos ya nos deja la última).
    const porDiaYMeso = new Map();
    // Nunca hay 2 mesociclos reales (tipo "sesion") distintos en la misma
    // semana de un cliente — con que aparezca uno, ya sabemos el de toda la
    // semana, junto con la "Semana" y "Semana del mesociclo" que se
    // calcularon y publicaron con él (Semanas.html las calcula solas a
    // partir del macrociclo, ver esa página).
    let semanaGlobal = null, semanaMesociclo = null, mesocicloSemana = null;
    filas.forEach(f => {
      const filaCliente = f[1], filaFecha = f[2], filaMesociclo = f[3];
      if (filaCliente !== cliente || !dias.includes(filaFecha)) return;
      porDiaYMeso.set(filaFecha + '|' + filaMesociclo, { fecha: filaFecha, mesociclo: filaMesociclo });

      const esSesionReal = CATEGORIA_VISUAL[filaMesociclo] && CATEGORIA_VISUAL[filaMesociclo].tipo === 'sesion';
      if (esSesionReal) {
        mesocicloSemana = filaMesociclo;
        // Valores congelados en el momento de publicar (fallback si no hay
        // macrociclo, o si el JSON guardado no se pudo leer) — se
        // sobrescriben más abajo con el cálculo en vivo cuando se puede.
        semanaGlobal = f[4] || null;
        semanaMesociclo = f[6] || null;
      }
    });

    // "Semana X/Y" en vivo: si el entrenador alarga o acorta un bloque del
    // macrociclo DESPUÉS de publicar esta semana, el texto congelado en
    // Sesiones_Programadas (arriba) se queda desactualizado — Nicolás vio
    // "semana 3/4" aunque su bloque de FMAX ya tenía una semana más. Se
    // recalcula aquí con el macrociclo actual del cliente, igual que hacen
    // Semanas.html y la rejilla de Programación; si no hay macrociclo, el
    // JSON no se pudo leer, o esta semana ya no encaja en él (fuera de rango,
    // o cambió de mesociclo), se deja el valor congelado de arriba tal cual.
    if (mesocicloSemana) {
      const plan = macrocicloMasReciente(filasMacro, cliente);
      if (plan && plan.inicio) {
        const calc = calcularFaseYSemana(plan.inicio, plan.bloques, dias[0]);
        if (!calc.fueraDeRango && calc.mesociclo === mesocicloSemana) {
          semanaGlobal = String(calc.semanaGlobal);
          semanaMesociclo = `${calc.semanaEnBloque}/${calc.semanasBloque}`;
        }
      }
    }

    // esEntrenador: para que el front pueda mostrar cosas que solo tienen
    // sentido para el entrenador (p.ej. el botón "Siguiente semana" en
    // cliente/semana.html) y nunca para el cliente real, aunque ambos usen
    // la misma página — lo calcula verificarAccesoCliente según si la
    // petición llegó con la Basic Auth del entrenador o con el token propio
    // del cliente.
    res.status(200).json({
      success: true,
      dias,
      sesiones: Array.from(porDiaYMeso.values()),
      esEntrenador: !!acceso.esEntrenador,
      mesociclo: mesocicloSemana,
      semana: semanaGlobal,
      semanaMesociclo,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
