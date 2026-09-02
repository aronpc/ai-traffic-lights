// validate.js — sanitização nos limites de confiança (payload de hook, paths).
// Os adapters recebem JSON de agentes externos; o state file vira caminho de
// arquivo. Sem validação, um session_id malicioso ("../foo") vira path traversal.
// Funções PURAS, testadas.

// IDs seguros p/ nome de arquivo: letras, dígitos, . _ - (estilo xid UUID).
// Rejeita '/', '..', espaços e qualquer outra coisa — fallback: o adapter
// ignora o evento (não escreve) em vez de gravar fora do STATE_DIR.
function validSessionId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 256 && /^[A-Za-z0-9._-]+$/.test(s);
}

// Shell-quote de um caminho p/ uso em command de hook (settings.json).
// Envolve em aspas simples e escapa ' internas. Previne quebra/interpretação
// se XDG_DATA_HOME ou HOME tiverem espaços ou metacaracteres.
function shellQuote(s) {
  if (typeof s !== 'string') return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Escape de string p/ o campo Exec de um .desktop (Desktop Entry Spec).
// Reservados que precisam de backslash: espaço e `" ` $ \ ; e outros de shell.
function desktopEscape(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\\$" `'*?();<>|&#~]/g, (c) => '\\' + c);
}

if (typeof module !== 'undefined') module.exports = { validSessionId, shellQuote, desktopEscape, boundsOnScreen };

// A posição salva de uma janela ainda cai DENTRO de alguma tela ativa?
// Valida contra TODAS as telas (não só a primária): num setup multi-monitor a
// janela movida pro monitor da esquerda/direita tinha a posição descartada em
// silêncio a cada reabertura, anulando o persist (PR-32 #19). Também protege o
// caso do monitor desconectado — aí nenhuma tela contém o ponto e o caller
// cai no default (centraliza no primário).
//   bounds:   {x, y}                    (posição salva)
//   displays: [{workArea:{x,y,width,height}}]   (screen.getAllDisplays())
function boundsOnScreen(bounds, displays) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  if (!Array.isArray(displays)) return false;
  return displays.some((d) => {
    const a = d && d.workArea;
    if (!a) return false;
    return bounds.x >= a.x && bounds.x < a.x + a.width &&
           bounds.y >= a.y && bounds.y < a.y + a.height;
  });
}
