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
const { execFileSync } = require('child_process');
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
    // is parent=shell (/proc probe) and the state file itself (the hook only fires
    // in an interactive session).
    return sessions.mergeSessions(stateFileSessions, discoveredTerminalAgents(existingAgentPids));
  } catch { return []; }
}

// Finds a session's transcript by session_id (searches the project roots
// from claude-config.js: config dir — incl. profile/dd-claude symlink — and the
// ~/.claude and ~/.zclaude histories).
function findTranscript(sid) {
  // sid arrives from the peer via /transcript?key= (network-controlled). Without validation,
  // "../foo" becomes path traversal (path.join) and reads any .jsonl on the host.
  // Rejects before it becomes a path — same validator as the adapters (validate.js).
  if (!validate.validSessionId(sid)) return null;
  for (const root of claudePaths.projectsRoots()) {
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
function backfillModels() {
  let changed = false;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const p = path.join(STATE_DIR, f);
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (s.model) continue;
        const tp = s.transcript_path || findTranscript(s.session_id);
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

// Probes /proc: discovers agents running in a terminal (parent = shell) that still
// DON'T have a state file — idle sessions or ones started before the adapter. Process
// names come from the registry (agents.js). (cwd unreadable due to ptrace_scope → these
// enter with the fallback label "<agent> · PID".)
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

function discoverAgentProcs(existingAgentPids) {
  const found = [];
  const kiroLockPid = getKiroLockPid();
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 2000 });
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const ppid = parseInt(m[2], 10);
        const argv = m[3].split(/\s+/);
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

        if (SHELLS.has(pcomm)) found.push({ pid, agent });
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
          const status = fs.readFileSync(`/proc/${ent}/status`, 'utf8');
          const m = status.match(/^PPid:\s+(\d+)/m);
          if (!m) continue;
          let pcomm = '';
          try { pcomm = fs.readFileSync(`/proc/${m[1]}/comm`, 'utf8').trim(); } catch {}
          if (pcomm.startsWith('-')) pcomm = pcomm.slice(1);
          if (SHELLS.has(pcomm)) found.push({ pid, agent });
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
  STATE_DIR,
};
