// adapters/kiro/ai-traffic-lights.js — adapter do Kiro CLI para o ai-traffic-lights.
//
// O Kiro não expõe hooks de shell como o Claude Code. Em vez disso, ele grava
// arquivos em ~/.kiro/sessions/cli/ que este adapter monitora com chokidar:
//
//   <uuid>.jsonl  — stream de eventos append-only (Prompt / AssistantMessage / ToolResults)
//   <uuid>.json   — estado consolidado da sessão (cwd, title, session_id)
//   <uuid>.lock   — {"pid": N, "started_at": "..."} — sessão ativa
//
// Mapeamento de eventos → vocabulário canônico do contrato:
//   Prompt           → UserPromptSubmit (usuário enviou mensagem → 🟡)
//   AssistantMessage → PostToolUse      (Kiro respondendo/pensando → 🟡)
//   ToolResults      → PreToolUse       (Kiro executou ferramenta → 🟡)
//   lock sumiu       → SessionEnd       (remove state file)
//   lock apareceu    → SessionStart     (nova sessão → 🟢)
//
// A escalada idle (verde→vermelho após N min) já é tratada pelo renderer.
//
// Este módulo é carregado pelo main.js e retorna { start, stop }.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const KIRO_SESSIONS_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
const DATA_HOME  = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const STATE_DIR  = path.join(DATA_HOME, 'ai-traffic-lights', 'state');
const SAFE_ID    = /^[A-Za-z0-9._-]+$/;

// ---- helpers de state file (mesma semântica do traffic-hook.sh) ----

function readState(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sid}.json`), 'utf8')); }
  catch { return {}; }
}

function writeState(sid, evt, tool) {
  if (!sid || !SAFE_ID.test(sid)) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${sid}.json`);
    const ex   = readState(sid);
    const now  = Math.floor(Date.now() / 1000);
    const st   = {
      schema_version: 2,
      agent:          'kiro',
      session_id:     sid,
      pid:            ex.pid   || null,
      cwd:            ex.cwd   || null,
      model:          ex.model || null,
      term_program:   null,
      windowid:       null,
      focus_url:      null,
      tilix_id:       null,
      zellij_session: null,
      last_event:     evt,
      last_event_ts:  now,
      last_tool:      tool || null,
      notification_type: null,
      events: [
        ...(Array.isArray(ex.events) ? ex.events : []),
        { ts: now, event: evt, tool: tool || null },
      ].slice(-50),
    };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(st));
    fs.renameSync(`${file}.tmp`, file);
  } catch {}
}

function dropState(sid) {
  if (!sid || !SAFE_ID.test(sid)) return;
  try { fs.unlinkSync(path.join(STATE_DIR, `${sid}.json`)); } catch {}
}

// ---- leitura dos arquivos do Kiro ----

// Lê o .json da sessão e enriquece o state file com cwd / pid.
function enrichFromSessionJson(sid) {
  const jsonFile = path.join(KIRO_SESSIONS_DIR, `${sid}.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const stateFile = path.join(STATE_DIR, `${sid}.json`);
    const ex = readState(sid);
    const enriched = { ...ex };
    if (meta.cwd)        enriched.cwd        = meta.cwd;
    if (meta.session_id) enriched.session_id = meta.session_id;
    if (Object.keys(enriched).length > Object.keys(ex).length) {
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(enriched));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    }
  } catch {}
}

// Lê o .lock e retorna { pid } ou null.
function readLock(sid) {
  try {
    const lock = JSON.parse(fs.readFileSync(
      path.join(KIRO_SESSIONS_DIR, `${sid}.lock`), 'utf8'));
    if (lock && typeof lock.pid === 'number') return lock;
  } catch {}
  return null;
}

// Extrai o session_id de um nome de arquivo (remove extensão).
function sidFromFile(file) {
  const base = path.basename(file);
  // aceita uuid com extensão: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.jsonl etc.
  const m = base.match(/^([A-Za-z0-9._-]+)\.(jsonl|json|lock|history)$/);
  return m ? m[1] : null;
}

// Processa a última linha do .jsonl para determinar o evento canônico.
function lastJsonlEvent(sid) {
  const file = path.join(KIRO_SESSIONS_DIR, `${sid}.jsonl`);
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trimEnd().split('\n');
    // busca a última linha válida
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        return d.kind || null; // 'Prompt' | 'AssistantMessage' | 'ToolResults'
      } catch {}
    }
  } catch {}
  return null;
}

// Mapeia kind do JSONL → evento canônico do contrato.
function toCanonical(kind) {
  switch (kind) {
    case 'Prompt':           return 'UserPromptSubmit';
    case 'AssistantMessage': return 'PostToolUse';
    case 'ToolResults':      return 'PreToolUse';
    default:                 return null;
  }
}

// ---- rastreamento de sessões ativas ----

// Map: sid → tamanho do .jsonl visto por último (evita re-processar linhas antigas)
const _jsonlSizes = new Map();

function handleJsonl(sid) {
  const jsonlFile = path.join(KIRO_SESSIONS_DIR, `${sid}.jsonl`);
  try {
    const stat = fs.statSync(jsonlFile);
    const prevSize = _jsonlSizes.get(sid) || 0;
    if (stat.size <= prevSize) return;
    _jsonlSizes.set(sid, stat.size);
  } catch { return; }

  const kind = lastJsonlEvent(sid);
  const evt  = toCanonical(kind);
  if (!evt) return;

  // Lê .lock ANTES do primeiro writeState para garantir pid no state file
  // e evitar race com process discovery (duas linhas pro mesmo pid).
  const lock = readLock(sid);

  enrichFromSessionJson(sid);

  // writeState preserva ex.pid; como lemos o lock antes, ex.pid já vem populado
  // pelo enrichFromSessionJson (que lê o state file existente) ou será null
  // se for a primeira escrita — mas o lock já foi lido acima.
  // Força o pid do lock no state file se ainda não tiver.
  if (lock) {
    const stateFile = path.join(STATE_DIR, `${sid}.json`);
    const ex = readState(sid);
    if (!ex.pid) {
      ex.pid = lock.pid;
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(ex));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    }
  }

  writeState(sid, evt, null);
}

function handleLock(sid, exists) {
  if (exists) {
    // Nova sessão ou re-apareceu — garante state file com pid do lock
    const stateFile = path.join(STATE_DIR, `${sid}.json`);
    const lock = readLock(sid);
    if (!lock) return; // lock inválido

    enrichFromSessionJson(sid);

    let st = {};
    try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}

    // Se já existe state file mas sem pid, atualiza com o pid do lock
    // (race: .jsonl criado antes do .lock → handleJsonl escreveu sem pid)
    const isFirstWrite = !st.pid || st.pid !== lock.pid;
    if (isFirstWrite) {
      st.schema_version = 2;
      st.agent = 'kiro';
      st.session_id = sid;
      st.pid = lock.pid;
      // preserva cwd/model/etc. do state existente se houver
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
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(st));
      fs.renameSync(`${stateFile}.tmp`, stateFile);

      // Avisa o main para invalidar cache de discovery imediatamente
      if (_onFirstWrite) _onFirstWrite();
    }
  } else {
    // Lock sumiu → sessão encerrou
    _jsonlSizes.delete(sid);
    dropState(sid);
  }
}

// ---- bootstrap: processa sessões já abertas ao iniciar o watcher ----

function bootstrap() {
  try {
    const files = fs.readdirSync(KIRO_SESSIONS_DIR);
    const locks = new Set(
      files.filter(f => f.endsWith('.lock')).map(f => f.replace('.lock', ''))
    );
    for (const sid of locks) {
      if (!SAFE_ID.test(sid)) continue;
      handleLock(sid, true);
      // processa estado atual do jsonl
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

// ---- API pública ----

let _watcher = null;
let _onFirstWrite = null;

function start(chokidar, onFirstWrite) {
  if (_watcher) return; // já rodando
  if (!fs.existsSync(KIRO_SESSIONS_DIR)) return; // Kiro não instalado

  _onFirstWrite = onFirstWrite || null;

  bootstrap();

  _watcher = chokidar.watch(KIRO_SESSIONS_DIR, {
    ignoreInitial:    true,
    depth:            0,         // só arquivos diretos, não subpastas
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });

  _watcher.on('all', (event, filePath) => {
    const sid = sidFromFile(filePath);
    if (!sid || !SAFE_ID.test(sid)) return;

    if (filePath.endsWith('.jsonl')) {
      if (event === 'change' || event === 'add') handleJsonl(sid);
    } else if (filePath.endsWith('.lock')) {
      if (event === 'add' || event === 'change') handleLock(sid, true);
      if (event === 'unlink')                    handleLock(sid, false);
    }
  });
}

function stop() {
  if (_watcher) { _watcher.close().catch(() => {}); _watcher = null; }
}

module.exports = { start, stop };
