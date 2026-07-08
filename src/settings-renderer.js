// settings-renderer.js — UI da janela de Preferências.
// Reusa o preload (window.trafficLight) do overlay. As mudanças aplicam AO VIVO:
// cada controle chama saveSettings() na hora → o main persiste e reemite
// 'settings-changed', e o overlay reflete imediatamente. Não há Salvar/Cancelar,
// só Fechar (o × do header também fecha). Captura o atalho do teclado e monta
// um accelerator do Electron.

const $idle = document.getElementById('idle');
const $lang = document.getElementById('lang');
const $sc = document.getElementById('shortcut');
const $opacity = document.getElementById('opacity');
const $opacityVal = document.getElementById('opacityVal');
const $markRead = document.getElementById('markRead');
const $notifyReset = document.getElementById('notifyReset');
const $resetThreshold = document.getElementById('resetThreshold');
const $resetThresholdVal = document.getElementById('resetThresholdVal');
const $terminal = document.getElementById('terminal');
const $terminalCmd = document.getElementById('terminalCmd');
const $terminalCmdField = document.getElementById('terminalCmdField');

let captured = null;        // accelerator capturado (string) ou null
let capturing = false;
let ready = false;          // trava o push durante a carga inicial (getSettings)
let T = makeT('en');        // i18n — troca pro idioma do sistema via get-lang

// Textos estáticos do HTML (labels, botões, hints, abas) + título da janela.
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

// Monta o cfg a partir dos campos atuais. O main mescla sobre o estado salvo,
// então mandar só os campos das Preferências é seguro (não zera showUsage etc.).
function buildCfg() {
  const v = $idle.value;
  const cfg = (v === 'never')
    ? { escalateIdle: false }
    : { escalateIdle: true, idleThresholdSec: parseInt(v, 10) };
  if (captured) cfg.shortcut = captured;
  cfg.lang = $lang.value;                    // 'auto' | 'en' | 'pt'
  cfg.terminal = $terminal.value;            // Quick Launcher: terminal de spawn
  if ($terminal.value === 'custom') cfg.terminalCmd = $terminalCmd.value.trim();
  cfg.opacity = (parseInt($opacity.value, 10) || 97) / 100;  // slider 60–100 → 0.6–1.0
  cfg.markReadOnClick = $markRead.checked;   // clique marca como lido
  cfg.notifyOnReset = $notifyReset.checked;  // avisar quando a cota resetar
  cfg.resetNotifyThresholdPct = parseInt($resetThreshold.value, 10) || 90; // limiar de "esgotado"
  return cfg;
}

// Aplica AO VIVO: grava + reemite settings-changed (o overlay reflete na hora).
function pushLive() {
  if (!ready) return;                        // ignora enquanto os campos são populados no load
  window.trafficLight.saveSettings(buildCfg());
}

// ---- captura do atalho ----
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
  if (acc) { setShortcut(acc); pushLive(); }                   // novo atalho aplica na hora
});

// ---- cada controle aplica na hora ----
$idle.addEventListener('change', pushLive);
$lang.addEventListener('change', pushLive);
$markRead.addEventListener('change', pushLive);
$notifyReset.addEventListener('change', pushLive);
// slider do limiar: atualiza o rótulo a cada pixel (barato/local); salva só ao
// soltar (change). Não afeta o overlay ao vivo, então dispensa o debounce do opacity.
$resetThreshold.addEventListener('input', () => { $resetThresholdVal.textContent = $resetThreshold.value + '%'; });
$resetThreshold.addEventListener('change', pushLive);
// Reflete a transparência na PRÓPRIA janela de Preferências: o painel .prefs usa
// var(--bg) → --bg-alpha (igual ao overlay). Só setar o CSS var local (barato).
function applyPrefsOpacity() {
  const op = (parseInt($opacity.value, 10) || 97) / 100;
  document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0.6, Math.min(1, op))));
}
// slider: atualiza rótulo + transparência das Prefs a cada pixel, mas DEBOUNCE o
// save no overlay — senão vira tempestade de resize/render/write no overlay
// durante o arraste. O 'change' (soltar) garante o valor final gravado na hora.
let opTimer = null;
$opacity.addEventListener('input', () => {
  $opacityVal.textContent = $opacity.value + '%';
  applyPrefsOpacity();
  clearTimeout(opTimer);
  opTimer = setTimeout(pushLive, 120);
});
$opacity.addEventListener('change', () => { clearTimeout(opTimer); pushLive(); });
$terminal.addEventListener('change', () => { syncTerminalCmdField(); pushLive(); });
$terminalCmd.addEventListener('change', pushLive);

// ---- abas: troca de painel (client-side) ----
const $tabs = document.querySelectorAll('.tab');
const $panels = document.querySelectorAll('.tab-panel');
function selectTab(name) {
  for (const t of $tabs) t.classList.toggle('is-active', t.dataset.tab === name);
  for (const p of $panels) p.hidden = p.dataset.panel !== name;
}
for (const t of $tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));

// ---- fechar (× do header e botão do rodapé; nada fica pendente) ----
document.getElementById('closeBtn').addEventListener('click', () => window.close());
document.getElementById('closeFooter').addEventListener('click', () => window.close());

// ---- espelho do tray: autostart + hooks (mostrar/ocultar e sair ficam só no tray) ----
const $autostart = document.getElementById('autostart');
$autostart.addEventListener('change', () => window.trafficLight.setAutostart($autostart.checked));
document.getElementById('installHooks').addEventListener('click', () => window.trafficLight.installHooks());
document.getElementById('removeHooks').addEventListener('click', () => window.trafficLight.removeHooks());

// Mostra o campo de comando custom só no modo 'custom' (hoisted — usado acima).
function syncTerminalCmdField() { $terminalCmdField.hidden = $terminal.value !== 'custom'; }

// ---- carga inicial ----
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
  if (c) {
    if (!c.escalateIdle) $idle.value = 'never';
    else $idle.value = String(c.idleThresholdSec || 300);
    $lang.value = c.lang || 'auto';
    setShortcut(c.shortcut || null);
    $terminal.value = c.terminal || 'auto';
    $terminalCmd.value = c.terminalCmd || '';
    const opct = Math.round((typeof c.opacity === 'number' ? c.opacity : 0.97) * 100);
    $opacity.value = String(opct);
    $opacityVal.textContent = opct + '%';
    $markRead.checked = c.markReadOnClick !== false; // default ligado
    $notifyReset.checked = c.notifyOnReset !== false; // default ligado
    const thr = typeof c.resetNotifyThresholdPct === 'number' ? c.resetNotifyThresholdPct : 90;
    $resetThreshold.value = String(thr);
    $resetThresholdVal.textContent = thr + '%';
  }
  applyPrefsOpacity();                               // aplica a transparência salva na janela de Prefs
  syncTerminalCmdField();
  ready = true;                                      // libera o live-apply só após popular tudo
});
window.trafficLight.getAutostart().then((on) => { $autostart.checked = !!on; });
