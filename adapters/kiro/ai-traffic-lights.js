// adapters/kiro/ai-traffic-lights.js — Kiro CLI adapter for ai-traffic-lights.
//
// Kiro does not expose shell hooks like Claude Code. Instead, it writes files
// to ~/.kiro/sessions/cli/ which this adapter monitors with chokidar:
//
//   <uuid>.jsonl  — append-only event stream (Prompt / AssistantMessage / ToolResults)
//   <uuid>.json   — consolidated session state (cwd, title, session_id)
//   <uuid>.lock   — {"pid": N, "started_at": "..."} — active session
//
// Event → canonical contract vocabulary mapping:
//   Prompt           → UserPromptSubmit (user sent a message → 🟡)
//   AssistantMessage → PreToolUse       (Kiro responding/thinking → 🟡)
//   ToolResults      → PostToolUse      (Kiro ran a tool → 🟡)
// The direction matters even though both map to PROCESSING (same color):
// `last_event` is displayed on the row, and saying "PreToolUse" after a tool
// FINISHES describes the opposite of what happened.
//   lock vanished    → SessionEnd       (removes state file)
//   lock appeared    → SessionStart     (new session → 🟢)
//   quiet jsonl      → Stop (synthesized) — Kiro's jsonl has NO end-of-turn
//                      marker; without this, an idle session stays 🟡 forever
//
// Idle escalation (green→red after N min) is already handled by the renderer.
//
// This module is loaded by main.js and returns { start, stop }.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const KIRO_SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
const DATA_HOME  = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const STATE_DIR  = path.join(DATA_HOME, 'ai-traffic-lights', 'state');
// Id validation comes from the shared, tested module (src/validate.js) instead
// of a 4th copy of the same regex. This adapter is loaded by the overlay
// (main.js:14, require relative to the app's __dirname), so the path resolves —
// unlike the OpenCode plugin, which runs inside the agent process.
const { validSessionId } = require('../../src/validate.js');
// Write + the contract golden rule come from the shared (tested) module:
// preserving transcript_path, focus fields and third-party keys is a rule,
// not a reminder — that was finding 08 of the PR #46 review.
const { atomicWrite, mergeState } = require('../../src/state-writer.js');

// Stop synthesis: Kiro never emits end-of-turn, so a turn that delivered the
// answer and went quiet would stay yellow forever. After STOP_AFTER_MS with
// no .jsonl growth, we record Stop (→ 🟢 → ⏰ red per the renderer's idle
// threshold). A mid-turn false positive (long turn with a gap in that window)
// only flashes green and re-lights on the next event — cosmetic.
const STOP_AFTER_MS = 120 * 1000;     // jsonl silence → turn considered stopped
const STALENESS_SCAN_MS = 30 * 1000;  // stop-scan interval

// ---- state file helpers (same semantics as traffic-hook.sh) ----

function readState(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sid}.json`), 'utf8')); }
  catch { return {}; }
}

// Atomic tmp+rename write with try/catch. EVERY write goes through here:
// an EACCES/ENOSPC/EROFS/EBUSY on the state must NOT take down the Electron
// main process (and with it the tray and the monitoring of all agents).
function writeState(sid, evt, tool, pid) {
  if (!validSessionId(sid)) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${sid}.json`);
    const ex   = readState(sid);
    const now  = Math.floor(Date.now() / 1000);
    // What THIS event knows. Everything else — including keys another writer
    // put here — is preserved by mergeState, not by a repeated list here.
    const st = mergeState(ex, {
      schema_version: 2,
      agent:         'kiro',
      session_id:    sid,
      pid:           pid || ex.pid || null,
      last_event:    evt,
      last_event_ts: now,
      last_tool:     tool || null,
    }, { ts: now, event: evt, tool: tool || null });
    atomicWrite(file, st, fs);
  } catch {}
}

function dropState(sid) {
  if (!validSessionId(sid)) return;
  try { fs.unlinkSync(path.join(STATE_DIR, `${sid}.json`)); } catch {}
}

// ---- reading Kiro files ----

// Reads the session .json and enriches the state file with cwd / pid.
function enrichFromSessionJson(sid) {
  const jsonFile = path.join(KIRO_SESSIONS_DIR, `${sid}.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const stateFile = path.join(STATE_DIR, `${sid}.json`);
    const ex = readState(sid);
    const enriched = { ...ex };
    // Save on PRESENCE of change, not on key count: Kiro's .json is born after
    // the .jsonl — on the 1st event the enrich throws (swallowed), writeState
    // writes with cwd:null, and on the following ones the count would already
    // match and the real cwd would NEVER arrive (the row shows the fallback
    // label "... · PID").
    if (meta.cwd)        enriched.cwd        = meta.cwd;
    if (meta.session_id) enriched.session_id = meta.session_id;
    const changed =
      (meta.cwd && enriched.cwd !== ex.cwd) ||
      (meta.session_id && enriched.session_id !== ex.session_id);
    if (changed) atomicWrite(stateFile, enriched, fs);
  } catch {}
}

// Reads the .lock and returns { pid } or null.
function readLock(sid) {
  try {
    const lock = JSON.parse(fs.readFileSync(
      path.join(KIRO_SESSIONS_DIR, `${sid}.lock`), 'utf8'));
    if (lock && typeof lock.pid === 'number') return lock;
  } catch {}
  return null;
}

// Extracts the session_id from a filename (strips the extension).
function sidFromFile(file) {
  const base = path.basename(file);
  // accepts uuid with extension: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.jsonl etc.
  const m = base.match(/^([A-Za-z0-9._-]+)\.(jsonl|json|lock|history)$/);
  return m ? m[1] : null;
}

// Processes the last .jsonl line to determine the canonical event.
function lastJsonlEvent(sid) {
  const file = path.join(KIRO_SESSIONS_DIR, `${sid}.jsonl`);
  try {
    const stat = fs.statSync(file);
    const fd  = fs.openSync(file, 'r');
    let pos = stat.size;
    let tail = Buffer.alloc(0);
    try {
      // Starts with a 64 KiB tail, but a JSONL entry can be larger. In that
      // case the first chunk starts mid-JSON; we back up in chunks until we
      // reach the '\n' delimiting the start of the last complete entry (or
      // the start of the file). The whole session is only read in the extreme
      // case of a single giant entry or a giant final write still incomplete.
      while (pos > 0) {
        const start = Math.max(0, pos - 65536);
        const chunk = Buffer.alloc(pos - start);
        const n = fs.readSync(fd, chunk, 0, chunk.length, start);
        tail = Buffer.concat([chunk.subarray(0, n), tail]);

        // If we haven't reached the start of the file, the prefix before the
        // first newline may be just a fragment and must never reach the parser.
        const firstNl = tail.indexOf(0x0a);
        if (start > 0 && firstNl < 0) { pos = start; continue; }
        const complete = start === 0 ? tail : tail.subarray(firstNl + 1);
        const lines = complete.toString('utf8').split('\n');
        // The final line may be mid-write. If it doesn't parse, use the
        // previous complete entry, preserving the existing behavior.
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const d = JSON.parse(lines[i]);
            return d.kind || null; // 'Prompt' | 'AssistantMessage' | 'ToolResults'
          } catch {}
        }
        pos = start;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

// Maps a JSONL kind → canonical contract event.
function toCanonical(kind) {
  switch (kind) {
    case 'Prompt':           return 'UserPromptSubmit';
    case 'AssistantMessage': return 'PreToolUse';
    case 'ToolResults':      return 'PostToolUse';
    default:                 return null;
  }
}

// ---- active session tracking ----

// Map: sid → last seen .jsonl size (avoids re-processing old lines)
const _jsonlSizes = new Map();
// Map: sid → ms of the last .jsonl growth (basis of the Stop synthesis)
const _lastSeen = new Map();

function handleJsonl(sid) {
  const jsonlFile = path.join(KIRO_SESSIONS_DIR, `${sid}.jsonl`);
  try {
    const stat = fs.statSync(jsonlFile);
    const prevSize = _jsonlSizes.get(sid) || 0;
    // Ignores only STAGNATION (equal size). Kiro compacts/rewrites the
    // .jsonl (/clear, crash-recovery, rotation): if the file SHRANK, we
    // re-read normally — with `<=` the session went permanently deaf after
    // a compaction.
    if (stat.size === prevSize) return;
    _jsonlSizes.set(sid, stat.size);
    _lastSeen.set(sid, Date.now());
  } catch { return; }

  const kind = lastJsonlEvent(sid);
  const evt  = toCanonical(kind);
  if (!evt) return;

  // Reads the .lock BEFORE the first writeState to guarantee pid in the state
  // file and avoid a race with process discovery (two rows for the same pid).
  const lock = readLock(sid);

  // Without pid (jsonl born before the .lock) does NOT write: a pid:null row
  // is invisible to readSessions dedup (requires agent+pid), becomes a zombie
  // that reapDead() skips and bypasses the lock filter in discovery (duplicate
  // row). The handleLock(add) that follows creates the state with the lock's pid.
  if (!lock && !readState(sid).pid) return;

  enrichFromSessionJson(sid);

  // The lock's pid cascades through writeState itself (avoids the extra
  // read+write of the old fixup block) — without a lock, preserves ex.pid
  // (SIGA without pid).
  writeState(sid, evt, null, lock && lock.pid);
}

function handleLock(sid, exists) {
  if (exists) {
    // New session or re-appeared — ensures a state file with the lock's pid
    _lastSeen.set(sid, Date.now());
    const stateFile = path.join(STATE_DIR, `${sid}.json`);
    const lock = readLock(sid);
    if (!lock) return; // invalid lock

    enrichFromSessionJson(sid);

    let st = {};
    try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}

    // If a state file already exists but has no pid, update it with the lock's pid
    // (race: .jsonl created before the .lock → handleJsonl wrote without pid)
    const isFirstWrite = !st.pid || st.pid !== lock.pid;
    if (isFirstWrite) {
      st.schema_version = 2;
      st.agent = 'kiro';
      st.session_id = sid;
      st.pid = lock.pid;
      // preserves cwd/model/etc. from the existing state if any
      if (!st.cwd) {
        try {
          const meta = JSON.parse(fs.readFileSync(
            path.join(KIRO_SESSIONS_DIR, `${sid}.json`), 'utf8'));
          st.cwd = meta.cwd || null;
        } catch {}
      }
      st.last_event = st.last_event || 'SessionStart';
      st.last_event_ts = st.last_event_ts || Math.floor(Date.now() / 1000);
      st.events = st.events || [{ ts: st.last_event_ts, event: 'SessionStart', tool: null }];
      atomicWrite(stateFile, st, fs);

      // Tells main to invalidate the discovery cache immediately
      if (_onFirstWrite) _onFirstWrite();
    }
  } else {
    // Lock vanished → session ended
    _jsonlSizes.delete(sid);
    _lastSeen.delete(sid);
    dropState(sid);
  }
}

// ---- bootstrap: processes already-open sessions when the watcher starts ----

function bootstrap() {
  try {
    const files = fs.readdirSync(KIRO_SESSIONS_DIR);
    const locks = new Set(
      files.filter(f => f.endsWith('.lock')).map(f => f.replace('.lock', ''))
    );
    for (const sid of locks) {
      if (!validSessionId(sid)) continue;
      handleLock(sid, true);
      _lastSeen.set(sid, Date.now());
      // process the current jsonl state
      const jsonlFile = path.join(KIRO_SESSIONS_DIR, `${sid}.jsonl`);
      try {
        const stat = fs.statSync(jsonlFile);
        _jsonlSizes.set(sid, stat.size);
        const kind = lastJsonlEvent(sid);
        const evt  = toCanonical(kind);
        if (evt) writeState(sid, evt, null);
      } catch {}
    }
  } catch {}
}

// ---- public API ----

let _watcher = null;
let _onFirstWrite = null;
let _staleTimer = null;
let _bootstrapImmediate = null;

const PROCESSING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

// Records Stop for sessions whose jsonl has been quiet for STOP_AFTER_MS and
// whose last event is still PROCESSING (open turn with no new downstream). After
// writing, re-anchors lastSeen so Stop isn't re-written in a 30s loop; any new
// jsonl line tears down the synthesis (back to yellow on the next real event).
function scanForStops() {
  const now = Date.now();
  for (const [sid, lastSeen] of _lastSeen) {
    if (now - lastSeen < STOP_AFTER_MS) continue;
    const st = readState(sid);
    if (!st || st.agent !== 'kiro' || !PROCESSING.has(st.last_event)) continue;
    writeState(sid, 'Stop', null);
    _lastSeen.set(sid, now);
  }
}

function start(chokidar, onFirstWrite) {
  if (_watcher) return; // already running
  if (!fs.existsSync(KIRO_SESSIONS_DIR)) return; // Kiro not installed

  _onFirstWrite = onFirstWrite || null;

  // DEFERRED bootstrap: reads of already-open sessions must NOT block the
  // ready createWindow() (PR-46 s8) — the watcher comes up active first and
  // the window opens in front; the initial state arrives on the first sendSessions.
  _bootstrapImmediate = setImmediate(() => { _bootstrapImmediate = null; bootstrap(); });

  _watcher = chokidar.watch(KIRO_SESSIONS_DIR, {
    ignoreInitial:    true,
    depth:            0,         // only direct files, not subdirectories
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });

  _staleTimer = setInterval(scanForStops, STALENESS_SCAN_MS);

  _watcher.on('all', (event, filePath) => {
    try {
      const sid = sidFromFile(filePath);
      if (!validSessionId(sid)) return;

      if (filePath.endsWith('.jsonl')) {
        if (event === 'change' || event === 'add') handleJsonl(sid);
      } else if (filePath.endsWith('.lock')) {
        if (event === 'add' || event === 'change') handleLock(sid, true);
        if (event === 'unlink')                    handleLock(sid, false);
      } else if (filePath.endsWith('.json')) {
        // Consolidated .json rewritten by Kiro on every message: re-enriches
        // cwd/session_id (add/change used to be silently dropped, so the real
        // cwd never reached the state file).
        if (event === 'add' || event === 'change') enrichFromSessionJson(sid);
      }
    } catch {}
  });
}

function stop() {
  if (_bootstrapImmediate) { clearImmediate(_bootstrapImmediate); _bootstrapImmediate = null; }
  if (_watcher) { _watcher.close().catch(() => {}); _watcher = null; }
  if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
}

module.exports = { start, stop };
