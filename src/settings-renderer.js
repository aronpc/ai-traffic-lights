// settings-renderer.js — UI for the Preferences window.
// Reuses the overlay's preload (window.trafficLight). Changes apply LIVE:
// each control calls saveSettings() immediately → main persists and re-emits
// 'settings-changed', and the overlay reflects it instantly. There is no
// Save/Cancel, only Close (the header × also closes). Captures the keyboard
// shortcut and builds an Electron accelerator.

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
const $betaChannel = document.getElementById('betaChannel');
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
const $syncEnabled = document.getElementById('syncEnabled');
const $syncToken = document.getElementById('syncToken');
const $syncNode = document.getElementById('syncNode');
const $syncPort = document.getElementById('syncPort');
const $syncShare = document.getElementById('syncShare');
const $syncShareTr = document.getElementById('syncShareTr');
const $syncAttach = document.getElementById('syncAttach');
const $syncPeers = document.getElementById('syncPeers');

let captured = null;        // captured accelerator (string) or null
let capturing = false;
// Quick Launcher: outside macOS the agent always opens in ATL's built-in
// Terminal window (spawn via node-pty + tmux wrap) — the external terminal
// selector has no effect on Linux. Hiding it avoids a preference that does nothing.
if (!/^Mac/.test(navigator.platform || '')) {
  const sec = $terminal && $terminal.closest('.section');
  if (sec) sec.hidden = true;
}
let ready = false;          // blocks push during initial load (getSettings)
let T = makeT('en');        // i18n — switches to the system language via get-lang
let soundFile = '';         // custom sound file path (set on load / when chosen)
// Preferences' own Web Audio, just for the "Test sound" button.
let prefsAudioCtx = null, prefsCustomBuffer = null, prefsCustomFor = null;

// Static texts from the HTML (labels, buttons, hints, tabs) + window title.
// document.title controls the window title (overrides main's option).
function applyI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  document.title = T('prefs_title');
  if (typeof relabelAllSelects === 'function') relabelAllSelects(); // custom dropdowns follow the language
}

const KEYNAME = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
const MODNAME = { ctrlKey: 'Control', altKey: 'Alt', shiftKey: 'Shift', metaKey: 'Super' };

// keydown → "Mod+...+Key" accelerator. Returns null if only modifiers so far.
function accelFromEvent(e) {
  const mods = [];
  for (const [prop, name] of Object.entries(MODNAME)) if (e[prop]) mods.push(name);
  let key = KEYNAME[e.key];
  if (!key) {
    if (/^[a-z0-9]$/i.test(e.key)) key = e.key.toUpperCase();
    else if (/^F([1-9]|1[0-2])$/i.test(e.key)) key = e.key.toUpperCase();
  }
  if (!key) return null;            // lone modifier / unsupported key
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

// Builds cfg from the current fields. Main merges over the saved state,
// so sending only the Preferences fields is safe (does not zero showUsage etc.).
function buildCfg() {
  const v = $idle.value;
  const cfg = (v === 'never')
    ? { escalateIdle: false }
    : { escalateIdle: true, idleThresholdSec: parseInt(v, 10) };
  if (captured) cfg.shortcut = captured;
  cfg.lang = $lang.value;                    // 'auto' | 'en' | 'pt'
  cfg.terminal = $terminal.value;            // Quick Launcher: spawn terminal
  if ($terminal.value === 'custom') cfg.terminalCmd = $terminalCmd.value.trim();
  cfg.opacity = (parseInt($opacity.value, 10) || 97) / 100;  // slider 60–100 → 0.6–1.0
  cfg.markReadOnClick = $markRead.checked;   // click marks as read
  cfg.notifyOnReset = $notifyReset.checked;  // notify when the quota resets
  cfg.revealOnRed = $revealRed.checked;      // bring to front when it turns red
  cfg.revealOnReset = $revealReset.checked;  // bring to front when the quota resets
  cfg.revealOnUpdate = $revealUpdate.checked; // bring to front on update
  cfg.updateChannel = $betaChannel.checked ? 'beta' : 'stable'; // update channel
  cfg.resetNotifyThresholdPct = parseInt($resetThreshold.value, 10) || 90; // "exhausted" threshold
  cfg.soundEnabled = $soundEnabled.checked;
  cfg.soundVolume = (parseInt($soundVolume.value, 10) || 0) / 100;  // slider 0–100 → 0–1
  cfg.soundType = $soundType.value;
  cfg.soundFile = soundFile;
  return cfg;
}

// Applies LIVE: saves + re-emits settings-changed (the overlay reflects it immediately).
function pushLive() {
  if (!ready) return;                        // ignore while fields are being populated on load
  window.trafficLight.saveSettings(buildCfg());
}

// Sync (P2P): saves ONLY the sync sub-object (via setSync — validated and
// applySync'd in main). Textarea parser: 1 peer/line, "host" or "name host".
function buildSyncCfg() {
  const peers = [];
  for (const raw of ($syncPeers.value || '').split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (!parts[0]) continue;
    const host = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const name = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
    peers.push({ name: name || host, host });
  }
  return {
    enabled: $syncEnabled.checked,
    token: $syncToken.value,
    node: $syncNode.value.trim(),
    port: parseInt($syncPort.value, 10) || 47474,
    share: $syncShare.checked,
    shareTranscripts: $syncShareTr.checked,
    allowAttach: $syncAttach.checked,
    peers,
  };
}
function pushSync() { if (ready) window.trafficLight.setSync(buildSyncCfg()); }
// Sync sub-toggles stay disabled (and half-faded) while the master `enabled`
// switch is off — visually signals that nothing is active.
function syncFieldState() {
  const on = $syncEnabled.checked;
  for (const $e of [$syncShare, $syncShareTr, $syncAttach, $syncToken, $syncNode, $syncPort, $syncPeers]) $e.disabled = !on;
}

// ---- shortcut capture ----
$sc.addEventListener('click', () => {
  capturing = true;
  $sc.classList.add('capturing');
  $sc.textContent = T('shortcut_capture');
});
$sc.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') { setShortcut(captured); return; }   // exits without changing
  const acc = accelFromEvent(e);
  if (acc) { setShortcut(acc); pushLive(); }                   // new shortcut applies immediately
});

// ---- each control applies immediately ----
$idle.addEventListener('change', pushLive);
$lang.addEventListener('change', pushLive);
$markRead.addEventListener('change', pushLive);
$notifyReset.addEventListener('change', pushLive);
$revealRed.addEventListener('change', pushLive);
$revealReset.addEventListener('change', pushLive);
$revealUpdate.addEventListener('change', pushLive);
$betaChannel.addEventListener('change', pushLive);
// threshold slider: updates the label at every pixel (cheap/local); saves only
// on release (change). Does not affect the live overlay, so it skips the opacity debounce.
$resetThreshold.addEventListener('input', () => { $resetThresholdVal.textContent = $resetThreshold.value + '%'; });
$resetThreshold.addEventListener('change', pushLive);
// ---- alert sound ----
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
  prefsCustomBuffer = null; prefsCustomFor = null;   // forces re-decode on the next test
  pushLive();
});
// Shows the file field only in 'custom' mode (hoisted — used on load and above).
function syncSoundFileField() { $soundFileField.hidden = $soundType.value !== 'custom'; }
// Prefs' own AudioContext (the overlay has its own). Preview for the "Test" button.
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
  } catch { /* preview must never break the UI */ }
}
// Reflects the transparency in the Preferences window ITSELF: the .prefs panel
// uses var(--bg) → --bg-alpha (same as the overlay). Just set the local CSS var (cheap).
function applyPrefsOpacity() {
  const op = (parseInt($opacity.value, 10) || 97) / 100;
  document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0.6, Math.min(1, op))));
}
// slider: updates the Prefs label + transparency at every pixel, but DEBOUNCES
// the save to the overlay — otherwise it becomes a storm of resize/render/write
// on the overlay during the drag. 'change' (release) ensures the final value is
// saved immediately.
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
// ---- multi-machine sync (each control applies immediately) ----
$syncEnabled.addEventListener('change', () => { syncFieldState(); pushSync(); });
$syncShare.addEventListener('change', pushSync);
$syncShareTr.addEventListener('change', pushSync);
$syncAttach.addEventListener('change', pushSync);
$syncToken.addEventListener('change', pushSync);
$syncNode.addEventListener('change', pushSync);
$syncPort.addEventListener('change', pushSync);
$syncPeers.addEventListener('change', pushSync);

// ---- tabs: panel switching (client-side) ----
const $tabs = document.querySelectorAll('.tab');
const $panels = document.querySelectorAll('.tab-panel');
function selectTab(name) {
  for (const t of $tabs) t.classList.toggle('is-active', t.dataset.tab === name);
  for (const p of $panels) p.hidden = p.dataset.panel !== name;
}
for (const t of $tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));

// ---- close (header × and footer button; nothing stays pending) ----
document.getElementById('closeBtn').addEventListener('click', () => window.close());
document.getElementById('closeFooter').addEventListener('click', () => window.close());

// ---- tray mirror: autostart + hooks (show/hide and quit stay tray-only) ----
const $autostart = document.getElementById('autostart');
$autostart.addEventListener('change', () => window.trafficLight.setAutostart($autostart.checked));
document.getElementById('installHooks').addEventListener('click', () => window.trafficLight.installHooks());
document.getElementById('removeHooks').addEventListener('click', () => window.trafficLight.removeHooks());

// Shows the custom command field only in 'custom' mode (hoisted — used above).
function syncTerminalCmdField() { $terminalCmdField.hidden = $terminal.value !== 'custom'; }

// Replaces native <select>s with custom dropdowns BEFORE load (avoids the
// native select flash while getSettings resolves); load re-syncs the labels.
enhanceAllSelects();

// ---- initial load ----
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
    $markRead.checked = c.markReadOnClick !== false; // default on
    $notifyReset.checked = c.notifyOnReset !== false; // default on
    $revealRed.checked = c.revealOnRed === true;      // default off
    $revealReset.checked = c.revealOnReset === true;  // default off
    $revealUpdate.checked = c.revealOnUpdate === true; // default off
    $betaChannel.checked = c.updateChannel === 'beta';   // default 'stable'
    const thr = typeof c.resetNotifyThresholdPct === 'number' ? c.resetNotifyThresholdPct : 90;
    $resetThreshold.value = String(thr);
    $resetThresholdVal.textContent = thr + '%';
    $soundEnabled.checked = c.soundEnabled !== false; // default on
    $soundType.value = c.soundType || 'beep';
    const sv = Math.round((typeof c.soundVolume === 'number' ? c.soundVolume : 0.18) * 100);
    $soundVolume.value = String(sv);
    $soundVolumeVal.textContent = sv + '%';
    soundFile = c.soundFile || '';
    $soundFileName.textContent = soundFile ? soundFile.split('/').pop() : '—';
  }
  applyPrefsOpacity();                               // applies the saved transparency to the Prefs window
  syncTerminalCmdField();
  syncSoundFileField();
  refreshAllSelects();                               // re-syncs the custom dropdowns with the loaded values
  ready = true;                                      // enables live-apply only after everything is populated
});
// Sync is a beta feature: the Synchronization tab only exists in beta builds
// (-beta.N version). In stable/source, we remove the tab + panel from the DOM.
window.trafficLight.syncAvailable().then((ok) => {
  if (ok) return;
  const tab = document.querySelector('.tab[data-tab="sync"]');
  const panel = document.querySelector('.tab-panel[data-panel="sync"]');
  if (tab) tab.remove();
  if (panel) panel.remove();
});
window.trafficLight.getAutostart().then((on) => { $autostart.checked = !!on; });
// Sync (P2P): populates the sync sub-object fields. Programmatic population
// does not fire 'change', so nothing is pushed — and pushSync() still respects `ready`.
window.trafficLight.getSync().then((s) => {
  s = s || {};
  $syncEnabled.checked = s.enabled === true;
  $syncToken.value = s.token || '';
  $syncNode.value = s.node || '';
  $syncPort.value = String(s.port || 47474);
  $syncShare.checked = s.share === true;
  $syncShareTr.checked = s.shareTranscripts === true;
  $syncAttach.checked = s.allowAttach === true;
  $syncPeers.value = (s.peers || []).map((p) => (p.name && p.name !== p.host ? `${p.name} ${p.host}` : p.host)).join('\n');
  syncFieldState();   // reflects the enabled state → sub-toggles on/off
});
