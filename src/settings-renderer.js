// settings-renderer.js — UI da janela de Preferências.
// Reusa o preload (window.trafficLight) do overlay. Captura o atalho do
// teclado e monta um accelerator do Electron.

const $idle = document.getElementById('idle');
const $lang = document.getElementById('lang');
const $sc = document.getElementById('shortcut');
const $save = document.getElementById('save');
const $cancel = document.getElementById('cancel');

let captured = null;        // accelerator capturado (string) ou null
let capturing = false;
let T = makeT('en');        // i18n — troca pro idioma do sistema via get-lang

// Textos estáticos do HTML (labels, botões, hints) + título da janela.
// document.title manda no título da janela (sobrepõe a option do main).
function applyI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  document.title = T('prefs_title');
}

const KEYNAME = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
const MODNAME = { ctrlKey: 'Control', altKey: 'Alt', shiftKey: 'Shift', metaKey: 'Super' };

// keydown → accelerator "Mod+...+Key". Retorna null se ainda só modifiers.
function accelFromEvent(e) {
  const mods = [];
  for (const [prop, name] of Object.entries(MODNAME)) if (e[prop]) mods.push(name);
  let key = KEYNAME[e.key];
  if (!key) {
    if (/^[a-z0-9]$/i.test(e.key)) key = e.key.toUpperCase();
    else if (/^F([1-9]|1[0-2])$/i.test(e.key)) key = e.key.toUpperCase();
  }
  if (!key) return null;            // modifier solto / tecla não suportada
  return [...mods, key].join('+');
}

function pretty(acc) {
  if (!acc) return '—';
  return acc.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').replace('Super', 'Win');
}

function setShortcut(acc) {
  captured = acc;
  $sc.textContent = pretty(acc);
  $sc.classList.remove('capturing');
  capturing = false;
}

$sc.addEventListener('click', () => {
  capturing = true;
  $sc.classList.add('capturing');
  $sc.textContent = T('shortcut_capture');
});
$sc.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { setShortcut(captured); return; }   // sai sem mudar
  const acc = accelFromEvent(e);
  if (acc) setShortcut(acc);
});

$save.addEventListener('click', () => {
  const v = $idle.value;
  const cfg = (v === 'never')
    ? { escalateIdle: false }
    : { escalateIdle: true, idleThresholdSec: parseInt(v, 10) };
  if (captured) cfg.shortcut = captured;
  cfg.lang = $lang.value;                  // 'auto' | 'en' | 'pt'
  cfg.terminal = $terminal.value;          // Quick Launcher: terminal de spawn
  if ($terminal.value === 'custom') cfg.terminalCmd = $terminalCmd.value.trim();
  window.trafficLight.saveSettings(cfg);   // main aplica (atalho + idioma + overlay) e fecha
  window.close();
});
$cancel.addEventListener('click', () => window.close());

// ---- espelho do tray: autostart, hooks, mostrar/ocultar, sair ----
const $autostart = document.getElementById('autostart');
$autostart.addEventListener('change', () => window.trafficLight.setAutostart($autostart.checked));
document.getElementById('installHooks').addEventListener('click', () => window.trafficLight.installHooks());
document.getElementById('removeHooks').addEventListener('click', () => window.trafficLight.removeHooks());
document.getElementById('toggleVis').addEventListener('click', () => window.trafficLight.toggleVisibility());
document.getElementById('quit').addEventListener('click', () => window.trafficLight.quit());

// Carga inicial
window.trafficLight.getVersion().then((v) => { if (v) document.getElementById('ver').textContent = v; });
window.trafficLight.getRepoUrl().then((url) => {
  const $repo = document.getElementById('repoLink');
  if (url) {
    $repo.dataset.url = url;
    $repo.title = url.replace(/^https?:\/\//, '');
  }
});
document.getElementById('repoLink').addEventListener('click', (e) => {
  e.preventDefault();
  const url = e.currentTarget.dataset.url;
  if (url) window.trafficLight.openExternal(url);
});
window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyI18n(); });
window.trafficLight.getSettings().then((c) => {
  if (!c) return;
  if (!c.escalateIdle) $idle.value = 'never';
  else $idle.value = String(c.idleThresholdSec || 300);
  $lang.value = c.lang || 'auto';
  setShortcut(c.shortcut || null);
  $terminal.value = c.terminal || 'auto';
  $terminalCmd.value = c.terminalCmd || '';
  syncTerminalCmdField();
});
// ---- Quick Launcher: mostra o campo de comando custom só no modo 'custom' ----
const $terminal = document.getElementById('terminal');
const $terminalCmd = document.getElementById('terminalCmd');
const $terminalCmdField = document.getElementById('terminalCmdField');
function syncTerminalCmdField() { $terminalCmdField.hidden = $terminal.value !== 'custom'; }
$terminal.addEventListener('change', syncTerminalCmdField);
window.trafficLight.getAutostart().then((on) => { $autostart.checked = !!on; });
