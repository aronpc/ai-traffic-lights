// settings.js — configurações do usuário (threshold de idle + atalho global).
// Lógica PURA: defaults, merge e validação. main.js faz o I/O (ler/gravar
// settings.json) e a UI de Preferências chama estas funções.

const DEFAULTS = Object.freeze({
  idleThresholdSec: 300,        // verde→vermelho após N parado (5 min)
  escalateIdle: true,           // false = nunca escalar idle (sempre verde no Stop)
  shortcut: 'Control+Alt+H',    // atalho global de mostrar/ocultar
  lang: 'auto',                 // idioma da UI: 'auto' (locale do sistema) | 'en' | 'pt'
  terminal: 'auto',             // Quick Launcher: 'auto' (1º presente) | 'tilix' | 'gnome-terminal' | 'ghostty' | 'custom'
  terminalCmd: '',              // comando customizado p/ 'custom' (ex.: 'kitty --directory {cwd} -e {cmd}')
  launchers: {},                // override de path por agente: { claude: '/usr/local/bin/claude' }
  showUsage: true,              // footer: true = barras de uso | false = ícones do launcher
  collapsed: false,             // estado da janela: recolhido (só header+rodapé) | expandido
  opacity: 0.97,               // transparência do painel (0.6–1.0; alpha do fundo do overlay)
  compact: false,              // lista de sessões densa (esconde a sub-linha, aperta o padding)
  markReadOnClick: true,       // clicar num terminal vermelho marca como lido (cinza) até a próxima notificação
  notifyOnReset: true,         // notifica quando um limite ESGOTADO reseta a cota (voltou a liberar)
  resetNotifyThresholdPct: 90, // % de uso que "arma" o aviso de reset — só avisa se passou disto antes de resetar
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
    if (typeof raw.showUsage === 'boolean') out.showUsage = raw.showUsage;
    if (typeof raw.collapsed === 'boolean') out.collapsed = raw.collapsed;
    // opacity: número em [0.6, 1.0] (abaixo de 0.6 fica ilegível). Fora da faixa
    // ou não-número → clampa/ignora, nunca vira undefined.
    if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) {
      out.opacity = Math.max(0.6, Math.min(1.0, raw.opacity));
    }
    if (typeof raw.compact === 'boolean') out.compact = raw.compact;
    if (typeof raw.markReadOnClick === 'boolean') out.markReadOnClick = raw.markReadOnClick;
    if (typeof raw.notifyOnReset === 'boolean') out.notifyOnReset = raw.notifyOnReset;
    // resetNotifyThresholdPct: inteiro em [1, 100]; fora da faixa/não-número → default (90).
    if (typeof raw.resetNotifyThresholdPct === 'number' && Number.isFinite(raw.resetNotifyThresholdPct)) {
      out.resetNotifyThresholdPct = Math.max(1, Math.min(100, Math.round(raw.resetNotifyThresholdPct)));
    }
    if (isValidShortcut(raw.shortcut)) out.shortcut = raw.shortcut;
    if (raw.lang === 'auto' || raw.lang === 'en' || raw.lang === 'pt') out.lang = raw.lang;
    const TERMINAL_OK = new Set(['auto', 'tilix', 'gnome-terminal', 'ghostty', 'custom']);
    if (TERMINAL_OK.has(raw.terminal)) out.terminal = raw.terminal;
    if (typeof raw.terminalCmd === 'string' && raw.terminalCmd.length <= 1000) out.terminalCmd = raw.terminalCmd;
    // launchers: só strings (paths), chaves curtas — ignorado se malformado.
    if (raw.launchers && typeof raw.launchers === 'object' && !Array.isArray(raw.launchers)) {
      const clean = {};
      let n = 0;
      for (const [k, v] of Object.entries(raw.launchers)) {
        if (typeof k === 'string' && k.length <= 64 && typeof v === 'string' && v.length <= 4096) {
          clean[k] = v;
          if (++n > 32) break;
        }
      }
      out.launchers = clean;
    }
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { DEFAULTS, isValidShortcut, mergeWithDefaults };
