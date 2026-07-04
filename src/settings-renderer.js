// settings-renderer.js — UI da janela de Preferências.
// Reusa o preload (window.trafficLight) do overlay. Captura o atalho do
// teclado e monta um accelerator do Electron.

const $idle = document.getElementById('idle');
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
  window.trafficLight.saveSettings(cfg);   // main aplica (atalho + overlay) e fecha
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
window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyI18n(); });
window.trafficLight.getSettings().then((c) => {
  if (!c) return;
  if (!c.escalateIdle) $idle.value = 'never';
  else $idle.value = String(c.idleThresholdSec || 300);
  setShortcut(c.shortcut || null);
});
window.trafficLight.getAutostart().then((on) => { $autostart.checked = !!on; });
