// read-marks.js — persistent state of read marks (#56).
//
// Before sync, `readMarks` lived only in the renderer (in-memory Map) and died on
// restart; and marks coming from ANOTHER machine didn't exist. This module is the MAIN
// side of it: load/save of `read-marks.json` in BASE_DIR (same pattern as
// aliases.json/window.json) + LWW merge.
//
//   { 'local:1234': 1730000000, ... }   // key → readAt (epoch seconds)
//
// LWW (last-write-wins): for each key, the LARGEST readAt wins — explicit,
// because it's the only rule that holds up with independent clocks: re-writing an
// older mark can NEVER "un-read" a session. Pure module (no Electron) —
// main.js only orchestrates; the logic is directly testable with node:test.

const fs = require('fs');

// Loads the state from disk. Missing/corrupted file → {} (a lost read
// mark is degradable: the session just goes back to "unread").
function loadReadMarks(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && k && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Saves the state. Marks are RARE events (a click or a peer's POST), so a direct
// write without debounce — unlike usage.json (60s cycle), there's no churn.
// tmp+rename (same pattern as state-writer.atomicWrite): a truncated file would
// be silently swallowed by loadReadMarks's catch and ALL marks would be lost —
// the reader must never see a half-written JSON.
function saveReadMarks(file, state) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state || {}));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}   // no orphaned .tmp
    return false;
  }
}

// LWW merge of marks: [{key, readAt}] (already sanitized by the network — net.js
// validates types; here we trust but do NOT downgrade: readAt <= 0 is skipped).
// Returns { state, applied } — `applied` contains ONLY the marks that changed something (the
// caller pushes those to the renderer; the others don't even re-render).
function applyMarks(state, marks) {
  const out = { ...(state || {}) };
  const applied = [];
  if (!Array.isArray(marks)) return { state: out, applied };
  for (const m of marks) {
    if (!m || typeof m.key !== 'string' || !m.key) continue;
    const at = Math.floor(Number(m.readAt));
    if (!Number.isFinite(at) || at <= 0) continue;
    // LWW: an OLDER mark never regresses an already-applied newer one.
    if ((out[m.key] || 0) >= at) continue;
    out[m.key] = at;
    applied.push({ key: m.key, readAt: at });
  }
  return { state: out, applied };
}

// Subset of the state for the LIVE keys — re-seeding after reconnection.
// The renderer prunes the marks of sessions that left the list (peer went down →
// sessions disappeared → liveKeys without the key → delete). On reconnection, the
// re-anchored mark from readIdleSec arrives EQUAL/older than the persisted one — applyMarks's
// LWW skips it and `applied` comes out empty, so NOTHING was pushed and the
// session went back to red despite being read. The main's poll re-sends this
// subset AFTER the session push: the renderer's handler is LWW too,
// so an up-to-date key doesn't re-render and a pruned key goes back to painting gray.
function reseedMarks(state, keys) {
  const out = {};
  if (!Array.isArray(keys)) return out;
  for (const k of keys) {
    if (typeof k !== 'string' || !k) continue;
    const at = (state || {})[k];
    if (Number.isFinite(at) && at > 0) out[k] = Math.floor(at);
  }
  return out;
}

module.exports = { loadReadMarks, saveReadMarks, applyMarks, reseedMarks };
