// settings.js — user settings (idle threshold + global shortcut).
// PURE logic: defaults, merge and validation. main.js does the I/O (read/write
// settings.json) and the Preferences UI calls these functions.

const { SOUND_TYPES } = require('./sound'); // valid alert sound types

const DEFAULTS = Object.freeze({
  idleThresholdSec: 300,        // green→red after N seconds idle (5 min)
  escalateIdle: true,           // false = never escalate idle (always green on Stop)
  shortcut: 'Control+Alt+H',    // global show/hide shortcut
  lang: 'auto',                 // UI language: 'auto' (system locale) | 'en' | 'pt'
  terminal: 'auto',             // Quick Launcher: 'auto' (first found) | 'tilix' | 'gnome-terminal' | 'ghostty' | 'custom'
  terminalCmd: '',              // custom command for 'custom' (e.g. 'kitty --directory {cwd} -e {cmd}')
  launchers: {},                // path override per agent: { claude: '/usr/local/bin/claude' }
  showUsage: true,              // footer: true = usage bars | false = launcher icons
  groupByHost: true,            // list: per-machine headers when there are sessions from >1 host (#54)
  collapsed: false,             // window state: collapsed (header+footer only) | expanded
  opacity: 0.97,               // panel transparency (0.6–1.0; alpha of the overlay background)
  markReadOnClick: true,       // clicking a red terminal marks it as read (gray) until the next notification
  notifyOnReset: true,         // notifies when an EXHAUSTED limit resets the quota (available again)
  resetNotifyThresholdPct: 90, // usage % that "arms" the reset notice — only notifies if it went past this before resetting
  soundEnabled: true,          // play a sound on the red alert
  soundVolume: 0.18,           // alert volume (0–1; 0.18 = original beep volume)
  soundType: 'beep',           // synthetic preset (beep/double/chime/low) or 'custom' (file)
  soundFile: '',               // audio file path when soundType === 'custom'
  revealOnRed: false,          // bring the overlay to front (if hidden) when an agent turns red
  revealOnReset: false,        // bring to front when the quota resets
  revealOnUpdate: false,       // bring to front when a new version is available
  updateChannel: 'stable',     // update channel: 'stable' (default) | 'beta' (test builds)
  // ---- multi-machine sync (P2P via Tailscale) — FULLY OPT-IN, everything OFF ----
  sync: Object.freeze({
    enabled: false,            // master switch: turns server AND client on/off
    share: false,              // start the /sessions server (exposes my state)
    shareTranscripts: false,   // enable /transcript (exposes my prompts) — requires share
    allowAttach: false,        // enable /pty (remote attach to my terminal) — requires share; = remote exec
    port: 47474,               // port common to all nodes (convention for peers)
    token: '',                 // shared secret (required if enabled; constant-time compare)
    node: '',                  // this node's name in the overlay (default = hostname; empty → hostname)
    peers: [],                 // [{name, host}] nodes that I watch (client). host = Tailscale IP/name
  }),
});

const UPDATE_CHANNELS = Object.freeze(['stable', 'beta']);

// Translates the channel preference + the running version into the TWO flags
// electron-updater understands. Pure on purpose: the decision is testable
// without Electron.
//
//   stable → allowPrerelease=false. The GitHubProvider resolves the tag via
//            /releases/latest, which GitHub builds ignoring pre-releases —
//            beta channel builds stay invisible.
//   beta   → allowPrerelease=true. The provider then scans the atom feed and
//            accepts the newest entry, pre-release included.
//
// The 'beta' name is NOT decorative: GitHubProvider treats `alpha` and `beta`
// as native channels (fixed list in the code) and any other suffix as
// `isCustomChannel`, which it DISCARDS when scanning the feed. Practical
// consequence: whoever runs `0.7.4-beta.N` also receives a newer stable that
// shows up; whoever ran `0.7.4-dev.N` would only see other `-dev.*` and fall
// behind.
//
// allowDowngrade is what allows LEAVING the beta channel at will. Going back
// from `0.7.4-beta.3` to stable `0.7.3` is a semver downgrade, and without
// this flag the app would be stuck on beta. It stays on only in that case
// (running a pre-release and requesting stable) — never on a stable app,
// where it would only cause harm.
// True if the running version is a beta-channel pre-release (has a suffix
// after X.Y.Z, e.g. 0.7.4-beta.1). Reused by the updater (allowDowngrade) and
// by the sync feature gate — the Synchronization tab only exists in beta builds.
function isPrerelease(appVersion) {
  return /^\d+\.\d+\.\d+-/.test(String(appVersion || ''));
}
function updaterFlags(channel, appVersion) {
  const wantBeta = channel === 'beta';
  const onPrerelease = isPrerelease(appVersion);
  return { allowPrerelease: wantBeta, allowDowngrade: !wantBeta && onPrerelease };
}

// Valid keys for an Electron accelerator (safe subset).
const KEY = /^[A-Z0-9]$|^(F1[0-2]?|F[2-9])$|^(Space|Up|Down|Left|Right)$/;
const MODS = new Set(['Command', 'CommandOrControl', 'Control', 'Alt', 'Shift', 'Super', 'Option', 'Meta']);

// An accelerator is valid if it has ≥1 modifier + ≥1 non-modifier key,
// and all tokens are recognized. Avoids registering a useless/invalid combo.
function isValidShortcut(acc) {
  if (typeof acc !== 'string') return false;
  const parts = acc.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  let hasMod = false, hasKey = false;
  for (const p of parts) {
    if (MODS.has(p)) hasMod = true;
    else if (KEY.test(p)) hasKey = true;
    else return false;            // unknown token
  }
  return hasMod && hasKey;
}

// Shallow recursive merge with defaults: only accepts/validates keys. The
// result is always complete and valid, even if the file on disk is rotten.
function mergeWithDefaults(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.idleThresholdSec === 'number' && raw.idleThresholdSec >= 0) {
      out.idleThresholdSec = Math.floor(raw.idleThresholdSec);
    }
    if (typeof raw.escalateIdle === 'boolean') out.escalateIdle = raw.escalateIdle;
    if (typeof raw.showUsage === 'boolean') out.showUsage = raw.showUsage;
    if (typeof raw.groupByHost === 'boolean') out.groupByHost = raw.groupByHost;
    if (typeof raw.collapsed === 'boolean') out.collapsed = raw.collapsed;
    // opacity: number in [0.6, 1.0] (below 0.6 becomes unreadable). Out of
    // range or non-number → clamps/ignores, never becomes undefined.
    if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) {
      out.opacity = Math.max(0.6, Math.min(1.0, raw.opacity));
    }
    if (typeof raw.markReadOnClick === 'boolean') out.markReadOnClick = raw.markReadOnClick;
    if (typeof raw.notifyOnReset === 'boolean') out.notifyOnReset = raw.notifyOnReset;
    if (typeof raw.revealOnRed === 'boolean') out.revealOnRed = raw.revealOnRed;
    if (typeof raw.revealOnReset === 'boolean') out.revealOnReset = raw.revealOnReset;
    if (typeof raw.revealOnUpdate === 'boolean') out.revealOnUpdate = raw.revealOnUpdate;
    if (UPDATE_CHANNELS.includes(raw.updateChannel)) out.updateChannel = raw.updateChannel;
    // resetNotifyThresholdPct: integer in [1, 100]; out of range/non-number → default (90).
    if (typeof raw.resetNotifyThresholdPct === 'number' && Number.isFinite(raw.resetNotifyThresholdPct)) {
      out.resetNotifyThresholdPct = Math.max(1, Math.min(100, Math.round(raw.resetNotifyThresholdPct)));
    }
    if (typeof raw.soundEnabled === 'boolean') out.soundEnabled = raw.soundEnabled;
    // soundVolume: number in [0, 1]; out of range/non-number → default (0.18).
    if (typeof raw.soundVolume === 'number' && Number.isFinite(raw.soundVolume)) {
      out.soundVolume = Math.max(0, Math.min(1, raw.soundVolume));
    }
    if (typeof raw.soundType === 'string' && SOUND_TYPES.includes(raw.soundType)) out.soundType = raw.soundType;
    if (typeof raw.soundFile === 'string' && raw.soundFile.length <= 4096) out.soundFile = raw.soundFile;
    if (isValidShortcut(raw.shortcut)) out.shortcut = raw.shortcut;
    if (raw.lang === 'auto' || raw.lang === 'en' || raw.lang === 'pt') out.lang = raw.lang;
    const TERMINAL_OK = new Set(['auto', 'tilix', 'gnome-terminal', 'ghostty', 'iterm2', 'terminal', 'warp', 'custom']);
    if (TERMINAL_OK.has(raw.terminal)) out.terminal = raw.terminal;
    if (typeof raw.terminalCmd === 'string' && raw.terminalCmd.length <= 1000) out.terminalCmd = raw.terminalCmd;
    // launchers: only strings (paths), short keys — ignored if malformed.
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
    // sync (P2P): OPT-IN sub-object. Everything OFF/safe by default; validates
    // each field and sanitizes peers (host comes from config — size/format anti-abuse).
    if (raw.sync && typeof raw.sync === 'object' && !Array.isArray(raw.sync)) {
      const s = { ...DEFAULTS.sync };
      if (typeof raw.sync.enabled === 'boolean') s.enabled = raw.sync.enabled;
      if (typeof raw.sync.share === 'boolean') s.share = raw.sync.share;
      if (typeof raw.sync.shareTranscripts === 'boolean') s.shareTranscripts = raw.sync.shareTranscripts;
      if (typeof raw.sync.allowAttach === 'boolean') s.allowAttach = raw.sync.allowAttach;
      if (typeof raw.sync.port === 'number' && Number.isFinite(raw.sync.port)) {
        s.port = Math.max(1, Math.min(65535, Math.round(raw.sync.port)));
      }
      if (typeof raw.sync.token === 'string' && raw.sync.token.length <= 256) s.token = raw.sync.token;
      if (typeof raw.sync.node === 'string' && raw.sync.node.length <= 64) s.node = raw.sync.node;
      if (Array.isArray(raw.sync.peers)) {
        const cleanPeers = [];
        for (const p of raw.sync.peers) {
          if (!p || typeof p !== 'object') continue;
          const name = typeof p.name === 'string' ? p.name.slice(0, 64) : '';
          const host = typeof p.host === 'string' ? p.host.slice(0, 256) : '';
          if (host) cleanPeers.push({ name: name || host, host });
          if (cleanPeers.length >= 32) break;     // anti-abuse cap
        }
        s.peers = cleanPeers;
      }
      out.sync = Object.freeze(s);
    }
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { DEFAULTS, UPDATE_CHANNELS, isValidShortcut, mergeWithDefaults, updaterFlags, isPrerelease };
