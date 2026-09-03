/**
 * Rellena un <select> con los clientes activos (nombre y apellidos, orden
 * alfabético) para las herramientas del entrenador. El valor de cada <option>
 * es el email del cliente — lo que de verdad se usa para publicar. Recuerda
 * la última selección en localStorage (misma clave "kaska_cliente_actual"
 * que ya comparten Semanas.html / Sesiones.html / Macrociclos.html / Perfil
 * fisiológico), así no hay que volver a elegir cada vez.
 */
function escaparHtmlCliente(str) {
  return (str == null ? '' : String(str))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function cargarSelectorClientes(selectEl) {
  selectEl.innerHTML = '<option value="">Cargando clientes...</option>';
  selectEl.disabled = true;

  try {
    const res = await fetch('/api/listar-clientes');
    const data = await res.json();

    if (!data.success || !data.clientes || !data.clientes.length) {
      selectEl.innerHTML = '<option value="">— No se encontraron clientes —</option>';
      selectEl.disabled = false;
      return;
    }

    const guardado = localStorage.getItem('kaska_cliente_actual') || '';
    const opciones = data.clientes.map(c => {
      const seleccionado = c.email === guardado ? ' selected' : '';
      return `<option value="${escaparHtmlCliente(c.email)}"${seleccionado}>${escaparHtmlCliente(c.nombreCompleto)}</option>`;
    });
    selectEl.innerHTML = '<option value="">— Elegir cliente —</option>' + opciones.join('');
    selectEl.disabled = false;

    selectEl.addEventListener('change', () => {
      if (selectEl.value) localStorage.setItem('kaska_cliente_actual', selectEl.value);
    });
  } catch (e) {
    selectEl.innerHTML = '<option value="">Error al cargar clientes</option>';
    selectEl.disabled = false;
  }
}
