// collect.js — Electron-free COLLECTION core (phase 1 of the P2P sync).
//
// Everything that discovers sessions on THIS machine WITHOUT using Electron: read the state files
// in STATE_DIR, probe /proc (Linux) or ps (macOS) for agents running in a
// terminal, and find/backfill the Claude transcript. Because it lives here (without
// `require('electron')`), the SAME core is imported by main.js (GUI) and by the
// future agent.js (headless, for a display-less server).
//
// Contract (same as the hook): one session = 1 state file in STATE_DIR or 1 entry
// discovered via /proc; sessions.mergeSessions dedupes by sessionKey
// (namespaced by origin — see identity.js). A proc's cwd is unreadable
// (ptrace_scope), so /proc-only sessions enter with a fallback label.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const sessions = require('./sessions.js');
const { AGENTS } = require('./agents.js');
const validate = require('./validate.js');
const claudePaths = require('./claude-config.js');
const { atomicWrite } = require('./state-writer.js');

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const STATE_DIR = path.join(DATA_HOME, 'ai-traffic-lights', 'state');

// Detection maps → agent id (comm = process name; argv = basename of the
// script for Node CLIs whose comm is "node" — e.g. gemini). Derived from the registry.
const COMM_TO_AGENT = new Map();
const ARGV_TO_AGENT = new Map();
for (const [id, a] of Object.entries(AGENTS)) {
  for (const c of a.comm || []) COMM_TO_AGENT.set(c, id);
  for (const s of a.argv || []) ARGV_TO_AGENT.set(s, id);
}
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

// Reads state files + discovers agents via /proc and returns the merged/deduped list.
function readSessions() {
  try {
    const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
    const stateFileSessions = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
        if (s && s.session_id) stateFileSessions.push(s);
      } catch { /* partial/invalid — skipped */ }
    }
    // Map of agent -> Set<pid> of existing state files: the Kiro gate needs
    // to know which kiro pids ALREADY have state (those mergeSessions dedupes).
    const existingAgentPids = new Map();
    for (const s of stateFileSessions) {
      if (!s.agent || !s.pid) continue;
      if (!existingAgentPids.has(s.agent)) existingAgentPids.set(s.agent, new Set());
      existingAgentPids.get(s.agent).add(s.pid);
    }
    // Merge + dedup (pure logic in sessions.js). No term_program filter:
    // Tilix doesn't export TERM_PROGRAM and would vanish from the overlay. The "interactive" gate
    // is the /proc probe (parent=shell OR no controlling tty) and the state file itself.
    // flagTmuxDetached runs AFTER flagHeadless: a headless process has no tmux pane to probe,
    // and the detached flag must not shadow the headless one.
    return flagTmuxDetached(flagHeadless(sessions.mergeSessions(stateFileSessions, discoveredTerminalAgents(existingAgentPids))));
  } catch { return []; }
}

// State-file sessions can ALSO be headless: `claude -p` in a project with the hook
// installed fires SessionStart WITHOUT a terminal. Same kernel signal as discovery —
// probe the live pid's controlling tty and flag it. Dead/unreadable pid → flag
// untouched (a stale state file isn't proof of anything).
function flagHeadless(list) {
  for (const s of list) {
    if (!s.pid || s.headless || (s.origin || 'local') !== 'local') continue;
    try {
      // When the flag lands, term_program follows it to null — the schema
      // contract for headless sessions (there IS no terminal to name).
      if (process.platform === 'darwin') {
        const tty = execFileSync('ps', ['-p', String(s.pid), '-o', 'tty='], { encoding: 'utf8', timeout: 1000 }).trim();
        if (psTtyHeadless(tty)) { s.headless = true; s.term_program = null; }
      } else {
        const f = parseStatFields(fs.readFileSync(`/proc/${s.pid}/stat`, 'utf8'));
        if (f && f.ttyNr === 0) { s.headless = true; s.term_program = null; }
      }
    } catch {}
  }
  return list;
}

// tmux probe: flags LOCAL sessions whose tmux session has NO attached client.
// Before this, `detached` was only learned ON CLICK (src/ipc/focus.js asks
// list-clients and the notification explains) — the list itself couldn't tell
// a focusable row from one that would only say "attach it first". One
// `list-panes -a` answers for EVERY pane at once; `session_attached` is the
// number of clients attached to the pane's session (0 = detached). Cached 4s
// like the /proc probe — readSessions runs on every render tick.
//
// tmux missing / server down → null, which asserts NOTHING (same contract as
// the focus flow's `asked=false`): no tmux on the machine must not paint
// rows as detached.
const TMUX_PANE_RE = /^%[0-9]+$/;

// Pure parser: output of `tmux list-panes -a -F '#{pane_id} #{session_attached}'`
// → Map(pane_id → attached client count). Malformed lines are skipped, not fatal.
function parsePanesAttached(out) {
  const m = new Map();
  if (typeof out !== 'string') return m;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.lastIndexOf(' ');
    const pane = t.slice(0, sp);
    const n = parseInt(t.slice(sp + 1), 10);
    if (TMUX_PANE_RE.test(pane) && Number.isFinite(n)) m.set(pane, n);
  }
  return m;
}

// One tmux probe, ASYNC and fire-and-forget: the tick never waits for it. A
// hung tmux server (socket alive, server unresponsive) would stall a
// synchronous exec for the full timeout — and with it the Electron event
// loop, the UI and the IPC (review finding on PR #66). The tick reads the
// LAST resolved map; until one lands the probe is `null` and asserts
// nothing. Cache 4s, positive AND negative (a missing tmux binary must not
// re-fork the probe on every tick; same seal as the Kiro lock), one probe
// in flight at a time.
let _tmuxMap = null, _tmuxAt = 0, _tmuxInflight = false;
function tmuxPanesAttached() {
  if (_tmuxInflight || Date.now() - _tmuxAt < 4000) return _tmuxMap;
  _tmuxInflight = true;
  execFile('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_attached}'],
    { encoding: 'utf8', timeout: 2000 }, (err, out) => {
      _tmuxMap = err ? null : parsePanesAttached(out);   // no tmux / server down → no claim
      _tmuxAt = Date.now();
      _tmuxInflight = false;
    });
  return _tmuxMap;   // previous snapshot — null until the first one lands
}

// `panesAttached` is injectable (tests pass a Map); default = the live probe.
// Gate: LOCAL sessions only (the origin owns the tmux its pane lives in),
// a VALID pane id (`tmuxTarget`'s rule), never on top of headless. A pane
// ABSENT from the map (tmux restarted, pane destroyed) asserts nothing — the
// click flow re-derives the truth live anyway. Objects are freshly parsed
// from the state files every tick, so only the `true` case needs writing.
// The flag travels in the sync payload like `headless`: a session property
// the origin is authoritative about, not a machine-local pointer.
function flagTmuxDetached(list, panesAttached) {
  const panes = panesAttached !== undefined ? panesAttached : tmuxPanesAttached();
  if (!panes) return list;
  for (const s of list) {
    if (!s.pid || s.headless || (s.origin || 'local') !== 'local') continue;
    if (typeof s.tmux_pane !== 'string' || !TMUX_PANE_RE.test(s.tmux_pane)) continue;
    if (panes.get(s.tmux_pane) === 0) s.tmux_detached = true;
  }
  return list;
}

// Finds a session's transcript by session_id (searches the project roots
// from claude-config.js: config dir — incl. profile/dd-claude symlink — and the
// ~/.claude and ~/.zclaude histories). `extraConfigDirs` (CodeRabbit PR #63):
// CLAUDE_CONFIG_DIR of NAMED profiles, discovered from the live sessions'
// environ by the caller — projectsRoots() only knows THIS process's config
// dir, so a named-profile session would never find its transcript (no model
// backfill, no prompt view). Headless (agent.js) passes nothing: without a
// GUI there is no environ sweep — degrades to the standard roots.
function findTranscript(sid, extraConfigDirs = []) {
  // sid arrives from the peer via /transcript?key= (network-controlled). Without validation,
  // "../foo" becomes path traversal (path.join) and reads any .jsonl on the host.
  // Rejects before it becomes a path — same validator as the adapters (validate.js).
  if (!validate.validSessionId(sid)) return null;
  const roots = [];
  const add = (r) => { if (r && !roots.includes(r)) roots.push(r); };
  for (const r of claudePaths.projectsRoots()) add(r);
  // junk entries (null/undefined/non-string) are skipped BEFORE path.join —
  // join(null, …) throws (measured by the junk-extras test).
  for (const d of Array.isArray(extraConfigDirs) ? extraConfigDirs : []) {
    if (typeof d === 'string' && d) add(path.join(d, 'projects'));
  }
  for (const root of roots) {
    try {
      for (const proj of fs.readdirSync(root)) {
        const p = path.join(root, proj, sid + '.jsonl');
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  return null;
}

// Last model used in a transcript.
function lastModel(tp) {
  try {
    if (!tp || !fs.existsSync(tp) || fs.statSync(tp).size > 50_000_000) return null;
    const data = fs.readFileSync(tp, 'utf8');
    let last = null, m;
    const re = /"model":"([^"]+)"/g;
    while ((m = re.exec(data))) last = m[1];
    return last;
  } catch { return null; }
}

// Backfill: sessions with model=null pick up the model from the transcript (right away, at startup).
// `extraConfigDirs` feeds findTranscript (named profiles — see there).
function backfillModels(extraConfigDirs = []) {
  let changed = false;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const p = path.join(STATE_DIR, f);
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (s.model) continue;
        const tp = s.transcript_path || findTranscript(s.session_id, extraConfigDirs);
        const m = tp && lastModel(tp);
        if (m) {
          s.transcript_path = tp; s.model = m;
          // same atomic write as the adapters (no race with the hook) — src/state-writer.js
          if (atomicWrite(p, s)) changed = true;
        }
      } catch {}
    }
  } catch {}
  return changed;
}

// Probes /proc: discovers agents running in a terminal that still DON'T have a state
// file — idle sessions or ones started before the adapter. Two ways IN (see
// acceptedProc): the classic parent=shell (attached), and a controlling tty of 0 —
// HEADLESS agents (nohup, SDK, claude -p spawned by another tool), invisible before:
// no shell parent AND no state file. Process names come from the registry (agents.js).
// (cwd unreadable due to ptrace_scope → these enter with the fallback label
// "<agent> · PID".)
// ---- Kiro: LOCK FILE discovery (ported from PR #46) ----
// Kiro leaves a .lock with the pid of the active session. It's the only kiro pid
// "authorized" to enter discovery without a state file — the other kiro
// processes are helpers and would become phantom rows in the overlay.
const KIRO_LOCK_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');

// 4s cache, POSITIVE and NEGATIVE: with no Kiro on the system, the readdirSync that gets
// ENOENT isn't re-paid on every refresh. The cached pid is re-checked for
// liveness — a stale .lock left on disk with a dead process must not shield
// discovery.
let _kiroLockPid = null, _kiroLockAt = 0;
function getKiroLockPid() {
  if (Date.now() - _kiroLockAt < 4000) {
    if (_kiroLockPid) {
      try { process.kill(_kiroLockPid, 0); return _kiroLockPid; } catch { _kiroLockPid = null; }
    }
    return _kiroLockPid;
  }
  try {
    for (const f of fs.readdirSync(KIRO_LOCK_DIR).filter((x) => x.endsWith('.lock'))) {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(KIRO_LOCK_DIR, f), 'utf8'));
        if (lock && typeof lock.pid === 'number') {
          try { process.kill(lock.pid, 0); } catch { continue; }   // a dead lock is garbage
          _kiroLockPid = lock.pid; _kiroLockAt = Date.now();
          return _kiroLockPid;
        }
      } catch {}
    }
  } catch {}
  _kiroLockPid = null; _kiroLockAt = Date.now();   // seals the negative cache (4s)
  return null;
}

// Lets through the live lock's pid, or a pid that ALREADY has a state file (mergeSessions
// dedupes that one). Any other kiro is a helper → discard. Doesn't depend on
// "some kiro exists in state": that gate caused amnesia, discarding the live
// lock forever as long as any old state existed on disk.
function kiroRejeitado(agent, pid, kiroLockPid, existingAgentPids) {
  if (agent !== 'kiro' || kiroLockPid === pid) return false;
  const statePids = existingAgentPids && existingAgentPids.get('kiro');
  return !statePids || !statePids.has(pid);
}

// /proc/<pid>/stat line → { ppid, ttyNr }. The line is "pid (comm) state ppid pgrp
// session tty_nr …"; comm can hold spaces AND parens, so fields are only trustworthy
// AFTER the last ')'. tty_nr (field 7) is the CONTROLLING terminal: 0 = no terminal
// owns the process (nohup, SDK, cron, a claude -p spawned by a tool) — a kernel fact,
// immune to whoever the parent happens to be.
function parseStatFields(stat) {
  if (typeof stat !== 'string') return null;
  const i = stat.lastIndexOf(')');
  if (i < 0) return null;
  const f = stat.slice(i + 2).split(/\s+/);
  const ppid = parseInt(f[1], 10);
  const ttyNr = parseInt(f[4], 10);
  if (Number.isNaN(ppid) || Number.isNaN(ttyNr)) return null;
  return { ppid, ttyNr };
}

// Discovery gate (pure): a shell parent with a tty is the classic ATTACHED session;
// tty_nr=0 is a HEADLESS one. The tty WINS over the parent: a claude -p run from
// another agent's Bash tool has a shell parent but no controlling tty — there is no
// window to focus, so it is headless. A non-shell parent WITH a tty stays out, as
// before (daemons, MCP servers).
function acceptedProc(pcomm, ttyNr) {
  if (ttyNr === 0) return { headless: true };
  if (SHELLS.has(pcomm)) return { headless: false };
  return null;
}

// macOS `ps -o tty=` prints `??` (TWO chars) when no controlling terminal
// exists — not Linux ps's single `?`. Any '?'-prefixed value is "no tty";
// anything else ('ttys001') is a real terminal. One matcher for both dialects.
function psTtyHeadless(tty) {
  return typeof tty === 'string' && tty.trim().startsWith('?');
}

function discoverAgentProcs(existingAgentPids) {
  const found = [];
  const kiroLockPid = getKiroLockPid();
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,tty=,args='], { encoding: 'utf8', timeout: 2000 });
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const ppid = parseInt(m[2], 10);
        // '?'/'??' = no controlling terminal (headless); 'ttys001' has one.
        const ttyNr = psTtyHeadless(m[3]) ? 0 : 1;
        const argv = m[4].split(/\s+/);
        const comm = path.basename(argv[0] || '');

        let agent = COMM_TO_AGENT.get(comm);
        if (!agent && (comm === 'node' || comm === 'node-options') && ARGV_TO_AGENT.size) {
          for (let i = 1; i < argv.length; i++) {
            agent = ARGV_TO_AGENT.get(path.basename(argv[i] || ''));
            if (agent) break;
          }
        }
        if (!agent) continue;
        if (kiroRejeitado(agent, pid, kiroLockPid, existingAgentPids)) continue;

        let pcomm = '';
        try {
          pcomm = path.basename(execFileSync('ps', ['-p', ppid, '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim());
        } catch {}
        if (pcomm.startsWith('-')) pcomm = pcomm.slice(1);

        const acc = acceptedProc(pcomm, ttyNr);
        if (acc) found.push({ pid, agent, ...(acc.headless ? { headless: true } : {}) });
      }
    } catch {}
  } else {
    try {
      for (const ent of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(ent)) continue;
        try {
          const pid = parseInt(ent, 10);
          const comm = fs.readFileSync(`/proc/${ent}/comm`, 'utf8').trim();
          let agent = COMM_TO_AGENT.get(comm);
          if (!agent && (comm === 'node' || comm === 'node-options') && ARGV_TO_AGENT.size) {
            try {
              const argv = fs.readFileSync(`/proc/${ent}/cmdline`, 'utf8').split('\0');
              agent = ARGV_TO_AGENT.get(path.basename(argv[1] || ''));
            } catch {}
          }
          if (!agent) continue;
          if (kiroRejeitado(agent, pid, kiroLockPid, existingAgentPids)) continue;
          // one read carries BOTH gates: ppid (for the parent comm) and tty_nr
          const f = parseStatFields(fs.readFileSync(`/proc/${ent}/stat`, 'utf8'));
          if (!f) continue;
          let pcomm = '';
          try { pcomm = fs.readFileSync(`/proc/${f.ppid}/comm`, 'utf8').trim(); } catch {}
          if (pcomm.startsWith('-')) pcomm = pcomm.slice(1);
          const acc = acceptedProc(pcomm, f.ttyNr);
          if (acc) found.push({ pid, agent, ...(acc.headless ? { headless: true } : {}) });
        } catch {}
      }
    } catch {}
  }
  return found;
}

// Short cache (4s) of the /proc probe — it runs on every render, but readdir on /proc
// costs. The main's 5s timer calls invalidateDiscovery() before re-reading.
let _disc = null, _discAt = 0;
function discoveredTerminalAgents(existingAgentPids) {
  if (_disc && Date.now() - _discAt < 4000) return _disc; // cache 4s
  _disc = discoverAgentProcs(existingAgentPids);
  _discAt = Date.now();
  return _disc;
}
function invalidateDiscovery() { _discAt = 0; }

module.exports = {
  readSessions, findTranscript, backfillModels,
  discoveredTerminalAgents, invalidateDiscovery,
  parseStatFields, acceptedProc, psTtyHeadless, flagHeadless,
  parsePanesAttached, flagTmuxDetached,
  STATE_DIR,
};
