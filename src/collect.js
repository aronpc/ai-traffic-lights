// collect.js — core de COLETA Electron-free (fase 1 do sync P2P).
//
// Tudo que descobre sessões DESTA máquina SEM usar Electron: ler os state files
// em STATE_DIR, sondar /proc (Linux) ou ps (macOS) atrás de agentes rodando em
// terminal, e achar/backfillar o transcript do Claude. Por viver aqui (sem
// `require('electron')`), o MESMO core é importado pelo main.js (GUI) e pelo
// futuro agent.js (headless, p/ servidor sem display).
//
// Contrato (igual ao hook): uma sessão = 1 state file em STATE_DIR ou 1 entrada
// descoberta via /proc; sessions.mergeSessions dedupa por sessionKey
// (namespaced por origin — ver identity.js). cwd de proc é ilegível
// (ptrace_scope), então sessões só-/proc entram com label fallback.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sessions = require('./sessions.js');
const { AGENTS } = require('./agents.js');

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const STATE_DIR = path.join(DATA_HOME, 'ai-traffic-lights', 'state');

// Mapas de detecção → agent id (comm = nome do processo; argv = basename do
// script p/ CLIs Node cujo comm é "node" — ex.: gemini). Derivados do registro.
const COMM_TO_AGENT = new Map();
const ARGV_TO_AGENT = new Map();
for (const [id, a] of Object.entries(AGENTS)) {
  for (const c of a.comm || []) COMM_TO_AGENT.set(c, id);
  for (const s of a.argv || []) ARGV_TO_AGENT.set(s, id);
}
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

// Lê state files + descobre agentes via /proc e devolve a lista mergeada/dedupada.
function readSessions() {
  try {
    const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
    const stateFileSessions = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
        if (s && s.session_id) stateFileSessions.push(s);
      } catch { /* parcial/inválido — ignora */ }
    }
    // Merge + dedup (lógica pura em sessions.js). Sem filtro por term_program:
    // Tilix não exporta TERM_PROGRAM e sumia do overlay. O gate de "interativo"
    // é o parent=shell (sonda /proc) e o próprio state file (hook só dispara
    // em sessão interativa).
    return sessions.mergeSessions(stateFileSessions, discoveredTerminalAgents());
  } catch { return []; }
}

// Acha o transcript de uma sessão pelo session_id (procura em .claude e .zclaude).
function findTranscript(sid) {
  for (const root of [
    path.join(process.env.HOME, '.claude/projects'),
    path.join(process.env.HOME, '.zclaude/projects'),
  ]) {
    try {
      for (const proj of fs.readdirSync(root)) {
        const p = path.join(root, proj, sid + '.jsonl');
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  return null;
}

// Último model usado num transcript.
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

// Backfill: sessões com model=null pegam o model do transcript (de cara, no startup).
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
          // tmp+rename: mesma escrita atômica dos adapters (sem race com o hook)
          fs.writeFileSync(p + '.tmp', JSON.stringify(s));
          fs.renameSync(p + '.tmp', p);
          changed = true;
        }
      } catch {}
    }
  } catch {}
  return changed;
}

// Sonda /proc: descobre agentes rodando em terminal (parent = shell) que AINDA
// NÃO têm state file — sessões idle ou iniciadas antes do adapter. Os nomes de
// processo vêm do registro (agents.js). (cwd ilegível por ptrace_scope → essas
// entram com label fallback "<agente> · PID".)
function discoverAgentProcs() {
  const found = [];
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
          const comm = fs.readFileSync(`/proc/${ent}/comm`, 'utf8').trim();
          let agent = COMM_TO_AGENT.get(comm);
          if (!agent && (comm === 'node' || comm === 'node-options') && ARGV_TO_AGENT.size) {
            try {
              const argv = fs.readFileSync(`/proc/${ent}/cmdline`, 'utf8').split('\0');
              agent = ARGV_TO_AGENT.get(path.basename(argv[1] || ''));
            } catch {}
          }
          if (!agent) continue;
          const status = fs.readFileSync(`/proc/${ent}/status`, 'utf8');
          const m = status.match(/^PPid:\s+(\d+)/m);
          if (!m) continue;
          let pcomm = '';
          try { pcomm = fs.readFileSync(`/proc/${m[1]}/comm`, 'utf8').trim(); } catch {}
          if (pcomm.startsWith('-')) pcomm = pcomm.slice(1);
          if (SHELLS.has(pcomm)) found.push({ pid: parseInt(ent, 10), agent });
        } catch {}
      }
    } catch {}
  }
  return found;
}

// Cache curto (4s) da sonda /proc — ela roda a cada render, mas readdir /proc
// custa. O timer de 5s do main chama invalidateDiscovery() antes de re-ler.
let _disc = null, _discAt = 0;
function discoveredTerminalAgents() {
  if (_disc && Date.now() - _discAt < 4000) return _disc; // cache 4s
  _disc = discoverAgentProcs();
  _discAt = Date.now();
  return _disc;
}
function invalidateDiscovery() { _discAt = 0; }

module.exports = {
  readSessions, findTranscript, backfillModels,
  discoveredTerminalAgents, invalidateDiscovery,
  STATE_DIR,
};
