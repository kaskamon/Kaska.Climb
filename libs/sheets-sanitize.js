// Evita la inyección de fórmulas de Sheets: un valor que llega de un
// formulario (alta pública, sesión de un cliente...) y se escribe con
// valueInputOption:'USER_ENTERED' se interpreta y EJECUTA como fórmula si
// empieza por =, +, - o @ (p.ej. =IMPORTXML(...) puede exfiltrar el resto de
// la fila, o un =HYPERLINK(...) puede colar un enlace de phishing que parece
// un dato normal). Anteponer un apóstrofe fuerza a Sheets a tratarlo como
// texto literal, igual que si lo escribieras a mano en la propia hoja.
function sanearFormula(valor) {
  if (typeof valor !== 'string') return valor;
  return /^[=+\-@]/.test(valor) ? `'${valor}` : valor;
}

module.exports = { sanearFormula };
