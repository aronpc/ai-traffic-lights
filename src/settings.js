// settings.js — configurações do usuário (threshold de idle + atalho global).
// Lógica PURA: defaults, merge e validação. main.js faz o I/O (ler/gravar
// settings.json) e a UI de Preferências chama estas funções.

const DEFAULTS = Object.freeze({
  idleThresholdSec: 300,        // verde→vermelho após N parado (5 min)
  escalateIdle: true,           // false = nunca escalar idle (sempre verde no Stop)
  shortcut: 'Control+Alt+H',    // atalho global de mostrar/ocultar
  lang: 'auto',                 // idioma da UI: 'auto' (locale do sistema) | 'en' | 'pt'
});

// Teclas válidas p/ um accelerator do Electron (subset seguro).
const KEY = /^[A-Z0-9]$|^(F1[0-2]?|F[2-9])$|^(Space|Up|Down|Left|Right)$/;
const MODS = new Set(['Command', 'CommandOrControl', 'Control', 'Alt', 'Shift', 'Super', 'Option', 'Meta']);

// Um accelerator é válido se tem ≥1 modificador + ≥1 tecla não-modificadora,
// e todos os tokens são reconhecidos. Evita registrar combinação inútil/inválida.
function isValidShortcut(acc) {
  if (typeof acc !== 'string') return false;
  const parts = acc.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  let hasMod = false, hasKey = false;
  for (const p of parts) {
    if (MODS.has(p)) hasMod = true;
    else if (KEY.test(p)) hasKey = true;
    else return false;            // token desconhecido
  }
  return hasMod && hasKey;
}

// Merge recursivo raso com defaults: só aceita chaves/valida. Resultado é
// sempre completo e válido, mesmo que o arquivo no disco esteja podre.
function mergeWithDefaults(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.idleThresholdSec === 'number' && raw.idleThresholdSec >= 0) {
      out.idleThresholdSec = Math.floor(raw.idleThresholdSec);
    }
    if (typeof raw.escalateIdle === 'boolean') out.escalateIdle = raw.escalateIdle;
    if (isValidShortcut(raw.shortcut)) out.shortcut = raw.shortcut;
    if (raw.lang === 'auto' || raw.lang === 'en' || raw.lang === 'pt') out.lang = raw.lang;
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { DEFAULTS, isValidShortcut, mergeWithDefaults };
