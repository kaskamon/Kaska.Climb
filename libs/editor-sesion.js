// Motor genérico de bloques/ejercicios de una sesión — compartido entre
// Sesiones.html (creador de plantillas libres) y el modal "Diseñar sesión"
// de Semanas.html. Depende de que exista en el DOM #contenedor-partes y
// #titulo-entreno-principal antes de cargar este script, y de que la página
// anfitriona defina su propia función autoGuardar() (aquí solo se la llama
// por nombre — cada página decide si persiste el borrador o no).

const contenedorPartes = document.getElementById('contenedor-partes');
const inputTituloPrincipal = document.getElementById('titulo-entreno-principal');

let contadorPartes = 0;

document.addEventListener('input', (e) => {
  if (e.target.matches('.celda-editable, .celda-cabecera-editable, .input-titulo-gran-formato, .input-titulo, .input-descripcion')) {
    autoGuardar();
  }
});

function obtenerDatosEstructura() {
  const datosEntreno = { tituloPrincipal: inputTituloPrincipal.value, partes: [] };
  const elementos = contenedorPartes.querySelectorAll('.bloque-parte, .cabecera-principal-empresa');

  elementos.forEach(el => {
    if (el.classList.contains('cabecera-principal-empresa')) {
      datosEntreno.partes.push({
        tipo: 'cabecera_separadora',
        tituloPrincipal: el.querySelector('.input-titulo-gran-formato').value
      });
    } else {
      const ejercicios = [];
      el.querySelectorAll('.cuerpo-tabla-ejercicios tr').forEach(fila => {
        const celdas = fila.querySelectorAll('.celda-editable');
        if (celdas.length >= 3) {
          ejercicios.push({
            nombre: celdas[0].innerText,
            series: celdas[1].innerText,
            notas: celdas[2].innerText
          });
        }
      });
      datosEntreno.partes.push({
        tipo: 'bloque_ejercicios',
        titulo: el.querySelector('.input-titulo').innerText,
        descripcion: el.querySelector('.input-descripcion').innerText,
        ejercicios: ejercicios
      });
    }
  });
  return datosEntreno;
}

function crearCabeceraUI(tituloTexto) {
  const div = document.createElement('div');
  div.className = 'cabecera-principal-empresa';
  div.innerHTML = `
    <div class="contenedor-titulo-principal">
      <input type="text" class="input-titulo-gran-formato" value="${tituloTexto}">
    </div>
    <div class="zona-ordenar no-print" style="gap: 5px; align-items:center;">
      <button class="btn-orden btn-subir-cabecera" title="Subir">▲</button>
      <button class="btn-orden btn-bajar-cabecera" title="Bajar">▼</button>
      <button class="btn-accion btn-eliminar btn-eliminar-cabecera" style="margin-left:5px;">✖</button>
    </div>
  `;
  contenedorPartes.appendChild(div);

  div.querySelector('.btn-eliminar-cabecera').addEventListener('click', () => { div.remove(); autoGuardar(); });
  div.querySelector('.btn-subir-cabecera').addEventListener('click', () => {
    const ant = div.previousElementSibling;
    if (ant) { contenedorPartes.insertBefore(div, ant); autoGuardar(); }
  });
  div.querySelector('.btn-bajar-cabecera').addEventListener('click', () => {
    const sig = div.nextElementSibling;
    if (sig) { contenedorPartes.insertBefore(sig, div); autoGuardar(); }
  });
  autoGuardar();
}

function crearParteUI(tituloVal = '', descripcionVal = '', ejerciciosLista = []) {
  contadorPartes++;
  const bloqueParte = document.createElement('div');
  bloqueParte.className = 'bloque-parte';

  bloqueParte.innerHTML = `
    <div class="cabecera-parte">
      <div class="zona-ordenar">
        <button class="btn-orden btn-subir-parte" title="Subir parte">▲</button>
        <button class="btn-orden btn-bajar-parte" title="Bajar parte">▼</button>
      </div>
      <div class="input-titulo celda-cabecera-editable" contenteditable="true" placeholder="Ej: Parte ${contadorPartes} - Movilidad">${tituloVal}</div>
      <div class="input-descripcion celda-cabecera-editable" contenteditable="true" placeholder="Explicación general de esta parte...">${descripcionVal}</div>
      <button class="btn-accion btn-eliminar btn-eliminar-parte">Eliminar Parte</button>
    </div>
    <table class="tabla-ejercicios">
      <thead>
        <tr>
          <th>Ejercicio</th>
          <th>Series / Tiempo</th>
          <th>Notas</th>
          <th>Acción</th>
        </tr>
      </thead>
      <tbody class="cuerpo-tabla-ejercicios"></tbody>
    </table>
    <button class="btn-accion btn-añadir-ejercicio">＋ Añadir Ejercicio</button>
  `;

  contenedorPartes.appendChild(bloqueParte);
  const cuerpoTabla = bloqueParte.querySelector('.cuerpo-tabla-ejercicios');

  function añadirFilaEjercicio(ej = { nombre: '', series: '', notas: '' }) {
    const fila = document.createElement('tr');
    fila.innerHTML = `
      <td class="celda-editable" contenteditable="true" placeholder="Nombre del ejercicio">${ej.nombre}</td>
      <td class="celda-editable" contenteditable="true" placeholder="Ej: 3x10">${ej.series}</td>
      <td class="celda-editable" contenteditable="true" placeholder="Notas...">${ej.notas}</td>
      <td style="white-space: nowrap;">
        <button class="btn-orden btn-subir-ej" title="Subir ejercicio">▲</button>
        <button class="btn-orden btn-bajar-ej" title="Bajar ejercicio">▼</button>
        <button class="btn-accion btn-eliminar btn-eliminar-ejercicio">✖</button>
      </td>
    `;
    cuerpoTabla.appendChild(fila);

    fila.querySelector('.btn-eliminar-ejercicio').addEventListener('click', () => { fila.remove(); autoGuardar(); });
    fila.querySelector('.btn-subir-ej').addEventListener('click', () => {
      const ant = fila.previousElementSibling;
      if (ant) { fila.parentNode.insertBefore(fila, ant); autoGuardar(); }
    });
    fila.querySelector('.btn-bajar-ej').addEventListener('click', () => {
      const sig = fila.nextElementSibling;
      if (sig) { fila.parentNode.insertBefore(sig, fila); autoGuardar(); }
    });
    autoGuardar();
  }

  bloqueParte.querySelector('.btn-subir-parte').addEventListener('click', () => {
    const ant = bloqueParte.previousElementSibling;
    if (ant) { contenedorPartes.insertBefore(bloqueParte, ant); autoGuardar(); }
  });

  bloqueParte.querySelector('.btn-bajar-parte').addEventListener('click', () => {
    const sig = bloqueParte.nextElementSibling;
    if (sig) { contenedorPartes.insertBefore(sig, bloqueParte); autoGuardar(); }
  });

  bloqueParte.querySelector('.btn-añadir-ejercicio').addEventListener('click', () => añadirFilaEjercicio());
  bloqueParte.querySelector('.btn-eliminar-parte').addEventListener('click', () => { bloqueParte.remove(); autoGuardar(); });

  if (ejerciciosLista.length > 0) {
    ejerciciosLista.forEach(ej => añadirFilaEjercicio(ej));
  } else {
    añadirFilaEjercicio();
  }
  autoGuardar();
}

function renderizarTodaLaTabla(appDatos) {
  contenedorPartes.innerHTML = '';
  contadorPartes = 0;
  inputTituloPrincipal.value = appDatos.tituloPrincipal || '';

  if (appDatos.partes && appDatos.partes.length > 0) {
    appDatos.partes.forEach(p => {
      if (p.tipo === 'cabecera_separadora') {
        crearCabeceraUI(p.tituloPrincipal);
      } else {
        crearParteUI(p.titulo, p.descripcion, p.ejercicios);
      }
    });
  } else {
    crearParteUI();
  }
}
