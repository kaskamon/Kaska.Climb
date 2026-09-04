const { google } = require('googleapis');
const { COLUMNS, CATEGORIA_VISUAL } = require('../libs/mesociclos-config.js');

const SPREADSHEET_ID = '1mfc4qr8xiiLmX8oA6f07XjMy7EhWwAcDEcDx3BmrLKM';
// Misma pestaña que lee api/obtener-sesion.js. Columnas: A marcaTemporal,
// B cliente, C fecha (dd/mm/aaaa), D mesociclo, E semana (la del macrociclo
// completo, tal cual la escribe el entrenador en Semanas.html), F json (el
// objeto {tituloPrincipal, partes} tal cual lo exporta Sesiones.html),
// G semanaMesociclo (p.ej. "3/6" — "Sem. Meso." de Semanas.html).
const SHEET_NAME = 'Sesiones_Programadas';

function parseFechaDDMMYYYY(s) {
  const [d, m, y] = (s || '').split('/').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d);
}
function lunesDe(date) {
  const diaSemana = date.getDay(); // 0=domingo .. 6=sábado
  const offsetALunes = diaSemana === 0 ? -6 : 1 - diaSemana;
  const lunes = new Date(date);
  lunes.setDate(lunes.getDate() + offsetALunes);
  lunes.setHours(0, 0, 0, 0);
  return lunes;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido, usa POST.' });
  }

  try {
    const { accion, cliente, fecha, mesociclo, sesion, semana, semanaMesociclo } = req.body || {};

    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Faltan las variables de entorno GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.',
      });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Borra TODA la semana ya publicada de un cliente (los 7 días, sea lo
    // que sea lo que tengan) — para cuando se publica algo por error y no
    // hay forma de deshacerlo desde "Limpiar Tabla" (que solo limpia el
    // borrador local, nunca toca lo ya publicado).
    if (accion === 'borrarSemana') {
      if (!cliente || !fecha) {
        return res.status(400).json({ success: false, error: 'Faltan datos (cliente o fecha) para borrar la semana.' });
      }
      const lunesABorrar = lunesDe(parseFechaDDMMYYYY(fecha) || new Date()).getTime();

      const [metaB, respB] = await Promise.all([
        sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }),
        sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:G` }),
      ]);
      const hojaB = metaB.data.sheets.find(s => s.properties.title === SHEET_NAME);
      const filasB = respB.data.values || [];
      const indices = [];
      filasB.forEach((f, i) => {
        if (f[1] !== cliente) return;
        const fechaFila = parseFechaDDMMYYYY(f[2]);
        if (fechaFila && lunesDe(fechaFila).getTime() === lunesABorrar) indices.push(i);
      });

      if (!indices.length) {
        return res.status(404).json({ success: false, error: 'Ese cliente no tiene nada publicado esa semana.' });
      }
      if (hojaB) {
        const sheetId = hojaB.properties.sheetId;
        const requests = indices
          .sort((a, b) => b - a)
          .map(i => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }));
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
      }
      return res.status(200).json({ success: true, message: `Semana borrada correctamente (${indices.length} día${indices.length === 1 ? '' : 's'}).` });
    }

    if (!cliente || !fecha || !mesociclo || !sesion) {
      return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (cliente, fecha, mesociclo o sesion).' });
    }
    if (!COLUMNS[mesociclo]) {
      return res.status(400).json({ success: false, error: `El mesociclo "${mesociclo}" no existe.` });
    }

    // Antes de escribir la versión nueva: (1) borramos cualquier fila que ya
    // hubiera para este mismo cliente+fecha — un día solo puede tener UNA
    // cosa programada, sea el mismo mesociclo o no (si había GYM-FMAX ese
    // día y ahora se publica DESCANSO, el GYM-FMAX debe desaparecer, no
    // quedarse enquistado); y (2) de paso aprovechamos para podar cualquier
    // fila de este cliente más vieja que las 2 últimas semanas — así solo
    // queda esa semana en curso y la anterior (suficiente para que un
    // cliente pueda completar tarde algo de la semana pasada), sin acumular
    // datos sin límite. La ventana de "2 semanas" se cuenta desde HOY (no
    // desde la fecha que se está publicando), para que corregir algo
    // antiguo nunca borre la semana actual por error.
    const cortePorAntiguedad = lunesDe(new Date());
    cortePorAntiguedad.setDate(cortePorAntiguedad.getDate() - 7);

    // Nunca puede haber 2 días reales de sesión (REOX/AERO/DESOX/FMAX/TAPERING)
    // en la misma semana de un cliente — si esta publicación es de uno de
    // ellos, cualquier otra fila real en la misma semana se considera
    // obsoleta (el trainer cambió de día o de idea) y se borra también. Esto
    // tiene que valer aunque sea EL MISMO mesociclo en otro día (p.ej.
    // publicar FMAX el sábado tras haberlo publicado por error el viernes) —
    // antes solo se comparaba con mesociclos distintos, así que ese caso
    // dejaba el día viejo huérfano en el Sheet.
    const esSesionReal = CATEGORIA_VISUAL[mesociclo] && CATEGORIA_VISUAL[mesociclo].tipo === 'sesion';
    const lunesPublicado = lunesDe(parseFechaDDMMYYYY(fecha) || new Date()).getTime();

    const [meta, resp] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:G` }),
    ]);
    const hoja = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
    const filas = resp.data.values || [];
    const indicesABorrar = [];
    filas.forEach((f, i) => {
      if (f[1] !== cliente) return;
      const esMismoDia = f[2] === fecha;
      const fechaFila = parseFechaDDMMYYYY(f[2]);
      const esAntigua = fechaFila ? lunesDe(fechaFila) < cortePorAntiguedad : false;
      const esOtroDiaRealMismaSemana = esSesionReal && !esMismoDia
        && CATEGORIA_VISUAL[f[3]] && CATEGORIA_VISUAL[f[3]].tipo === 'sesion'
        && fechaFila && lunesDe(fechaFila).getTime() === lunesPublicado;
      if (esMismoDia || esAntigua || esOtroDiaRealMismaSemana) indicesABorrar.push(i);
    });

    if (hoja && indicesABorrar.length) {
      const sheetId = hoja.properties.sheetId;
      const requests = indicesABorrar
        .sort((a, b) => b - a) // de la fila más abajo hacia arriba, para no desplazar los índices que faltan por borrar
        .map(i => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
    }

    const marcaTemporal = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_NAME}'!A:G`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[marcaTemporal, cliente, fecha, mesociclo, semana || '', JSON.stringify(sesion), semanaMesociclo || '']] },
    });

    // Arranque automático del contrato: la primera vez que se publica un
    // mesociclo real (no gym/roca/descanso) para un cliente que todavía no
    // tiene fecha de inicio en su ficha, se considera que "empieza a
    // entrenar" hoy — se fija inicio=hoy y fin=hoy+3 meses (trimestre
    // inicial). Nunca pisa una fecha ya puesta, así que republicar o editar
    // semanas más adelante no la vuelve a tocar. Si esto falla por lo que
    // sea, no debe tumbar la publicación real de la sesión (ya guardada).
    if (esSesionReal) {
      try {
        const CLIENTES_SPREADSHEET_ID = '10RasiExEFgUtGuFOeSCvnJWdMhtJZA3i0TSdChmkFv8';
        const CLIENTES_SHEET_NAME = 'Respuestas de formulario 1';
        const COL_CORREO = 6, COL_FECHA_INICIO = 12, COL_FECHA_FIN = 13;

        const respClientes = await sheets.spreadsheets.values.get({
          spreadsheetId: CLIENTES_SPREADSHEET_ID,
          range: `'${CLIENTES_SHEET_NAME}'!A:N`,
        });
        const filasClientes = respClientes.data.values || [];
        const correoBuscado = cliente.trim().toLowerCase();
        const indiceCliente = filasClientes.findIndex(f => (f[COL_CORREO] || '').trim().toLowerCase() === correoBuscado);

        if (indiceCliente !== -1 && !(filasClientes[indiceCliente][COL_FECHA_INICIO] || '').trim()) {
          const formatear = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
          const hoy = new Date();
          const fin = new Date(hoy);
          fin.setMonth(fin.getMonth() + 3);
          const filaSheetClientes = indiceCliente + 1;

          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: CLIENTES_SPREADSHEET_ID,
            requestBody: {
              valueInputOption: 'USER_ENTERED',
              data: [
                { range: `'${CLIENTES_SHEET_NAME}'!M${filaSheetClientes}`, values: [[formatear(hoy)]] },
                { range: `'${CLIENTES_SHEET_NAME}'!N${filaSheetClientes}`, values: [[formatear(fin)]] },
              ],
            },
          });
        }
      } catch (e) {
        // Se ignora a propósito: la publicación de la sesión ya se completó.
      }
    }

    res.status(200).json({ success: true, message: 'Sesión publicada correctamente.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
