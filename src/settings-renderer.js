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
const $revealRed = document.getElementById('revealOnRed');
const $revealReset = document.getElementById('revealOnReset');
const $revealUpdate = document.getElementById('revealOnUpdate');
const $resetThreshold = document.getElementById('resetThreshold');
const $resetThresholdVal = document.getElementById('resetThresholdVal');
const $soundEnabled = document.getElementById('soundEnabled');
const $soundType = document.getElementById('soundType');
const $soundVolume = document.getElementById('soundVolume');
const $soundVolumeVal = document.getElementById('soundVolumeVal');
const $soundFileField = document.getElementById('soundFileField');
const $soundPick = document.getElementById('soundPick');
const $soundFileName = document.getElementById('soundFileName');
const $soundTest = document.getElementById('soundTest');
const $terminal = document.getElementById('terminal');
const $terminalCmd = document.getElementById('terminalCmd');
const $terminalCmdField = document.getElementById('terminalCmdField');

let captured = null;        // accelerator capturado (string) ou null
let capturing = false;
let ready = false;          // trava o push durante a carga inicial (getSettings)
let T = makeT('en');        // i18n — troca pro idioma do sistema via get-lang
let soundFile = '';         // caminho do arquivo de som custom (setado no load / ao escolher)
// Web Audio próprio das Preferências, só para o botão "Testar som".
let prefsAudioCtx = null, prefsCustomBuffer = null, prefsCustomFor = null;

// Textos estáticos do HTML (labels, botões, hints, abas) + título da janela.
// document.title manda no título da janela (sobrepõe a option do main).
function applyI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  document.title = T('prefs_title');
  if (typeof relabelAllSelects === 'function') relabelAllSelects(); // dropdowns custom seguem o idioma
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
  cfg.revealOnRed = $revealRed.checked;      // trazer à frente ao ficar vermelho
  cfg.revealOnReset = $revealReset.checked;  // trazer à frente ao resetar a cota
  cfg.revealOnUpdate = $revealUpdate.checked; // trazer à frente ao ter update
  cfg.resetNotifyThresholdPct = parseInt($resetThreshold.value, 10) || 90; // limiar de "esgotado"
  cfg.soundEnabled = $soundEnabled.checked;
  cfg.soundVolume = (parseInt($soundVolume.value, 10) || 0) / 100;  // slider 0–100 → 0–1
  cfg.soundType = $soundType.value;
  cfg.soundFile = soundFile;
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
$revealRed.addEventListener('change', pushLive);
$revealReset.addEventListener('change', pushLive);
$revealUpdate.addEventListener('change', pushLive);
// slider do limiar: atualiza o rótulo a cada pixel (barato/local); salva só ao
// soltar (change). Não afeta o overlay ao vivo, então dispensa o debounce do opacity.
$resetThreshold.addEventListener('input', () => { $resetThresholdVal.textContent = $resetThreshold.value + '%'; });
$resetThreshold.addEventListener('change', pushLive);
// ---- som do alerta ----
$soundEnabled.addEventListener('change', pushLive);
$soundType.addEventListener('change', () => { syncSoundFileField(); pushLive(); });
$soundVolume.addEventListener('input', () => { $soundVolumeVal.textContent = $soundVolume.value + '%'; });
$soundVolume.addEventListener('change', pushLive);
$soundTest.addEventListener('click', testSound);
$soundPick.addEventListener('click', async () => {
  const p = await window.trafficLight.pickSoundFile();
  if (!p) return;
  soundFile = p;
  $soundFileName.textContent = p.split('/').pop();
  prefsCustomBuffer = null; prefsCustomFor = null;   // força redecodificar no próximo teste
  pushLive();
});
// Mostra o campo de arquivo só no modo 'custom' (hoisted — usado no load e acima).
function syncSoundFileField() { $soundFileField.hidden = $soundType.value !== 'custom'; }
// AudioContext próprio das Prefs (o overlay tem o seu). Preview do botão "Testar".
function prefsCtx() {
  prefsAudioCtx = prefsAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (prefsAudioCtx.state === 'suspended') prefsAudioCtx.resume();
  return prefsAudioCtx;
}
async function testSound() {
  try {
    const vol = (parseInt($soundVolume.value, 10) || 0) / 100;
    const type = $soundType.value;
    const ctx = prefsCtx();
    if (type === 'custom') {
      if (soundFile && (prefsCustomFor !== soundFile || !prefsCustomBuffer)) {
        const bytes = await window.trafficLight.getSoundBytes(soundFile);
        if (bytes && bytes.byteLength) {
          const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          prefsCustomBuffer = await ctx.decodeAudioData(ab); prefsCustomFor = soundFile;
        }
      }
      if (prefsCustomBuffer) { playBuffer(ctx, prefsCustomBuffer, vol); return; }
    }
    playPreset(ctx, type, vol);
  } catch { /* preview nunca quebra a UI */ }
}
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

// Troca os <select> nativos por dropdowns custom ANTES do load (evita o flash do
// select nativo enquanto o getSettings resolve); o load re-sincroniza os rótulos.
enhanceAllSelects();

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
    $revealRed.checked = c.revealOnRed === true;      // default desligado
    $revealReset.checked = c.revealOnReset === true;  // default desligado
    $revealUpdate.checked = c.revealOnUpdate === true; // default desligado
    const thr = typeof c.resetNotifyThresholdPct === 'number' ? c.resetNotifyThresholdPct : 90;
    $resetThreshold.value = String(thr);
    $resetThresholdVal.textContent = thr + '%';
    $soundEnabled.checked = c.soundEnabled !== false; // default ligado
    $soundType.value = c.soundType || 'beep';
    const sv = Math.round((typeof c.soundVolume === 'number' ? c.soundVolume : 0.18) * 100);
    $soundVolume.value = String(sv);
    $soundVolumeVal.textContent = sv + '%';
    soundFile = c.soundFile || '';
    $soundFileName.textContent = soundFile ? soundFile.split('/').pop() : '—';
  }
  applyPrefsOpacity();                               // aplica a transparência salva na janela de Prefs
  syncTerminalCmdField();
  syncSoundFileField();
  refreshAllSelects();                               // re-sincroniza os dropdowns custom com os values carregados
  ready = true;                                      // libera o live-apply só após popular tudo
});
window.trafficLight.getAutostart().then((on) => { $autostart.checked = !!on; });
