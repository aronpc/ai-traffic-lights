// i18n.js — strings da UI em inglês e português (lógica PURA, sem I/O).
// O idioma segue a localização do sistema: main.js resolve app.getLocale()
// via pickLang() e distribui aos renderers pelo IPC get-lang. Qualquer locale
// pt* (pt-BR, pt-PT, pt) vira 'pt'; todo o resto cai em 'en' — o app é
// distribuído para um público majoritariamente EN, então inglês é o default.
//
// Chave ausente num idioma cai no EN; ausente no EN devolve a própria chave
// (fail-soft: a UI nunca quebra por tradução faltando, no máximo fica feia).
// Placeholders: t('needs_you', {agent: 'Claude'}) substitui {agent}.

const STRINGS = {
  en: {
    // overlay
    empty_state: 'No active AI sessions.',
    tooltip_settings: 'preferences',
    tooltip_expand: 'expand/collapse',
    tooltip_close: 'hide',
    tooltip_grip: 'drag to resize',
    tooltip_summary: 'overall state',
    row_tooltip: 'click: focus terminal · double-click: rename',
    needs_you: '{agent} needs you',
    doc_sessions: 'sessions',
    // tray
    tray_show_hide: 'Show/Hide',
    tray_autostart: 'Start with the system',
    tray_install_hooks: 'Install/update hooks',
    tray_remove_hooks: 'Remove hooks',
    tray_preferences: 'Preferences…',
    tray_quit: 'Quit',
    // notificações do instalador de hooks
    ntf_installed: 'installed ({a}+{u})',
    ntf_ok: 'ok',
    ntf_plugin_ok: 'plugin ok',
    ntf_plugin_removed: 'plugin removed',
    ntf_removed: '{n} removed',
    ntf_none_found: 'No supported agent found.',
    ntf_nothing_installed: 'Nothing installed.',
    ntf_install_fail: 'Failed to install hook: {msg}',
    ntf_remove_fail: 'Failed to remove hook: {msg}',
    // janela de Preferências
    prefs_title: 'Preferences — AI Traffic Lights',
    prefs_h1: '🚦 Preferences',
    sec_behavior: 'Behavior',
    sec_startup: 'Startup',
    sec_integration: 'Integration (agents)',
    sec_window: 'Window',
    idle_label: 'Idle time before turning red',
    idle_1m: '1 minute',
    idle_2m: '2 minutes',
    idle_5m: '5 minutes (default)',
    idle_10m: '10 minutes',
    idle_15m: '15 minutes',
    idle_never: 'Never (always green when done)',
    idle_hint: 'A finished session left unattended longer than this turns 🔴.',
    shortcut_label: 'Show/hide shortcut',
    shortcut_hint: 'Click and press the combination. Needs a modifier (Ctrl/Alt/Shift/Super).',
    shortcut_capture: 'Press the keys… (Esc cancels)',
    lang_label: 'Language',
    lang_auto: 'Automatic (system)',
    lang_en: 'English',
    lang_pt: 'Português',
    autostart_label: 'Start with the system',
    hooks_install_btn: 'Install/update hooks',
    hooks_remove_btn: 'Remove hooks',
    hooks_hint: 'Registers the adapter in ~/.claude, ~/.gemini, ~/.codex and the OpenCode plugin. In Codex, run /hooks afterwards to trust it.',
    win_toggle_btn: 'Show/Hide overlay',
    win_quit_btn: 'Quit',
    btn_cancel: 'Cancel',
    btn_save: 'Save',
  },
  pt: {
    // overlay
    empty_state: 'Nenhuma sessão de IA ativa.',
    tooltip_settings: 'preferências',
    tooltip_expand: 'expandir/recolher',
    tooltip_close: 'ocultar',
    tooltip_grip: 'arraste para redimensionar',
    tooltip_summary: 'estado agregado',
    row_tooltip: 'clique: focar terminal · duplo-clique: renomear',
    needs_you: '{agent} precisa de você',
    doc_sessions: 'sessões',
    // tray
    tray_show_hide: 'Mostrar/Ocultar',
    tray_autostart: 'Iniciar com o sistema',
    tray_install_hooks: 'Instalar/atualizar hooks',
    tray_remove_hooks: 'Remover hooks',
    tray_preferences: 'Preferências…',
    tray_quit: 'Sair',
    // notificações do instalador de hooks
    ntf_installed: 'instalado ({a}+{u})',
    ntf_ok: 'ok',
    ntf_plugin_ok: 'plugin ok',
    ntf_plugin_removed: 'plugin removido',
    ntf_removed: '{n} removidas',
    ntf_none_found: 'Nenhum agente suportado encontrado.',
    ntf_nothing_installed: 'Nada instalado.',
    ntf_install_fail: 'Falha ao instalar hook: {msg}',
    ntf_remove_fail: 'Falha ao remover hook: {msg}',
    // janela de Preferências
    prefs_title: 'Preferências — AI Traffic Lights',
    prefs_h1: '🚦 Preferências',
    sec_behavior: 'Comportamento',
    sec_startup: 'Inicialização',
    sec_integration: 'Integração (agentes)',
    sec_window: 'Janela',
    idle_label: 'Tempo parado até virar vermelho (idle)',
    idle_1m: '1 minuto',
    idle_2m: '2 minutos',
    idle_5m: '5 minutos (padrão)',
    idle_10m: '10 minutos',
    idle_15m: '15 minutos',
    idle_never: 'Nunca (sempre verde quando pronto)',
    idle_hint: 'Uma sessão que terminou e ficou parada por mais que isso vira 🔴.',
    shortcut_label: 'Atalho de mostrar/ocultar',
    shortcut_hint: 'Clique e pressione a combinação. Precisa de um modificador (Ctrl/Alt/Shift/Super).',
    shortcut_capture: 'Pressione as teclas… (Esc cancela)',
    lang_label: 'Idioma',
    lang_auto: 'Automático (sistema)',
    lang_en: 'English',
    lang_pt: 'Português',
    autostart_label: 'Iniciar com o sistema',
    hooks_install_btn: 'Instalar/atualizar hooks',
    hooks_remove_btn: 'Remover hooks',
    hooks_hint: 'Registra o adapter em ~/.claude, ~/.gemini, ~/.codex e o plugin do OpenCode. No Codex, rode /hooks depois pra confiar.',
    win_toggle_btn: 'Mostrar/Ocultar overlay',
    win_quit_btn: 'Sair',
    btn_cancel: 'Cancelar',
    btn_save: 'Salvar',
  },
};

// Locale do sistema → idioma suportado. pt* → pt; resto → en.
function pickLang(locale) {
  return String(locale || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

// Tradução com fallback en → chave, e interpolação de {placeholders}.
function translate(lang, key, vars) {
  const dict = STRINGS[lang] || STRINGS.en;
  let s = dict[key] != null ? dict[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
  if (vars) for (const k of Object.keys(vars)) s = s.replaceAll(`{${k}}`, String(vars[k]));
  return s;
}

// t parcial por idioma — os call sites ficam limpos: T('empty_state').
function makeT(lang) { return (key, vars) => translate(lang, key, vars); }

if (typeof module !== 'undefined') module.exports = { STRINGS, pickLang, translate, makeT };
