// state-writer.js — state file writing for whoever runs INSIDE the overlay.
//
// It only serves the in-process writers (adapters/kiro, collect.js). The
// contract's other two writers are duplicated out of NECESSITY, not
// carelessness:
//   • hooks/traffic-hook.sh   — bash, runs in the agent's process
//   • adapters/opencode/…     — copied to ~/.config/opencode/plugin/ and
//                               loaded by OpenCode; never reaches this repo
// Either of the two would have to embed a copy anyway.
//
// What this module exists to guarantee is the contract's golden rule, which
// until now lived only in prose (docs/ARCHITECTURE.md, "Preserve, don't
// regress") and was violated for that reason — the Kiro adapter wiped
// `transcript_path` and the focus fields on every event (finding 08 of the
// PR #46 review). A rule in a comment is a suggestion; a rule in a function
// with a test is a contract.

const fs = require('fs');

// tmp + rename: the reader never sees a half-written file. Returns bool
// instead of throwing — an adapter must never take down its host.
//
// `fsImpl` exists because the Kiro adapter is loaded in a vm with a mocked
// `fs` in tests: without receiving the caller's fs, this module would write to
// the real disk and the test would stop isolating what it claims to isolate.
function atomicWrite(stateFile, obj, fsImpl) {
  const io = fsImpl || fs;
  const tmp = `${stateFile}.tmp`;
  try {
    io.writeFileSync(tmp, JSON.stringify(obj));
    io.renameSync(tmp, stateFile);
    return true;
  } catch {
    // The rename can fail with the payload ALREADY written (EACCES/EROFS/EBUSY
    // on the target). Without this the .tmp stays orphaned forever: readers
    // filter by `.json` and do not see it, so nobody cleans it up.
    try { io.unlinkSync(tmp); } catch {}
    return false;
  }
}

// Fields that belong to ANOTHER writer and that an event must never zero out:
//   transcript_path — comes from the overlay's backfillModels()
//   windowid/focus_url/tilix_id/iterm_id/zellij_session — click-to-focus
//   cwd/model/term_program — enrichment the event may not carry
const PRESERVADOS = [
  'cwd', 'model', 'transcript_path', 'term_program',
  'windowid', 'focus_url', 'tilix_id', 'iterm_id', 'zellij_session',
  'tmux_pane', 'tmux_session',
];

// `notification_type` is left OUT on purpose. The contract
// (docs/ARCHITECTURE.md) says "null unless last_event == Notification", and the
// hook rewrites it on every event precisely for that. Preserving it would make
// it sticky: a Stop after a permission_prompt would keep the old
// discriminator, and computeState would classify the NEXT untyped
// notification by the previous one's type.

// Merges the existing state with the event's patch. Three guarantees:
//   1. third-party keys survive (an adapter does not know what the others
//      wrote — deleting what it does not understand is the classic mistake);
//   2. PRESERVADOS fields only change if the patch carries a non-null value;
//   3. `events` is append-only with a cap of 50.
function mergeState(existente, patch, evento) {
  const ex = (existente && typeof existente === 'object') ? existente : {};
  // The patch is guarded too: inside the adapter this runs under a blind
  // catch, and a TypeError here would make the event vanish without a trace.
  // A module that exists to not take down the host cannot have an entrance
  // that throws.
  const pt = (patch && typeof patch === 'object') ? patch : {};
  const out = { ...ex, ...pt };
  for (const k of PRESERVADOS) {
    if (pt[k] == null) {                      // undefined OR null in the patch
      // `== null` and not `!== undefined`: an EXPLICIT `undefined` in the
      // patch left the key present-but-undefined, and JSON.stringify omitted
      // it from the file. The contract wants the field with null, not its
      // absence.
      out[k] = (ex[k] == null) ? null : ex[k];
    }
  }
  // The contract is explicit: `notification_type` describes the CURRENT event.
  // It comes from the patch or does not exist — never from the previous
  // state. Guarding only the non-Notification case left the hole narrower and
  // just as real: a NEW untyped Notification inherited the previous one's
  // discriminator, and computeState classified it by the wrong reason.
  out.notification_type = (pt.notification_type != null) ? pt.notification_type : null;

  if (evento) {
    const antes = Array.isArray(ex.events) ? ex.events : [];
    out.events = [...antes, evento].slice(-50);
  }
  return out;
}

module.exports = { atomicWrite, mergeState, PRESERVADOS };
