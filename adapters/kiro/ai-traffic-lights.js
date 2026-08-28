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
//   jsonl quieto     → Stop (sintetizado) — o jsonl do Kiro NÃO tem marcador de
//                      fim de turno; sem isto, sessão ociosa fica 🟡 para sempre
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

// Síntese de Stop: o Kiro nunca emite fim de turno, então um turno que entregou
// a resposta e ficou quieto permaneceria amarelo para sempre. Depois de
// STOP_AFTER_MS sem crescimento do .jsonl, registramos Stop (→ 🟢 → ⏰ vermelho
// conforme o threshold de idle do renderer). False-positive mid-turn (turno
// longo com gap aí) só pisca verde e re-acende no próximo evento — cosmético.
const STOP_AFTER_MS = 120 * 1000;     // silêncio do jsonl → turno considerado parado
const STALENESS_SCAN_MS = 30 * 1000;  // intervalo da varredura de parada

// ---- helpers de state file (mesma semântica do traffic-hook.sh) ----

function readState(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${sid}.json`), 'utf8')); }
  catch { return {}; }
}

// Escrita atômica tmp+rename com try/catch. TODA escrita passa por aqui:
// um EACCES/ENOSPC/EROFS/EBUSY no state NÃO pode derrubar o processo main do
// Electron (e com ele a tray e o monitoramento de todos os agentes).
function atomicWrite(stateFile, st) {
  try {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(st));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
    return true;
  } catch {}
  return false;
}

function writeState(sid, evt, tool) {
  if (!sid || !SAFE_ID.test(sid)) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, `${sid}.json`);
    const ex   = readState(sid);
    const now  = Math.floor(Date.now() / 1000);
    const st   = {
      // golden rule do adapter: PRESERVA chaves de terceiros e os canais de
      // foco do state existente (transcript_path vem do backfillModels() do
      // main — não pode regridir pra null — e windowid/focus_url/tilix_id
      // servem o click-to-focus).
      ...ex,
      schema_version: 2,
      agent:          'kiro',
      session_id:     sid,
      pid:            ex.pid || null,
      cwd:            ex.cwd || null,
      model:          ex.model || null,
      transcript_path: ex.transcript_path || null,
      term_program:   ex.term_program   || null,
      windowid:       ex.windowid       || null,
      focus_url:      ex.focus_url      || null,
      tilix_id:       ex.tilix_id       || null,
      zellij_session: ex.zellij_session || null,
      last_event:     evt,
      last_event_ts:  now,
      last_tool:      tool || null,
      notification_type: ex.notification_type || null,
      events: [
        ...(Array.isArray(ex.events) ? ex.events : []),
        { ts: now, event: evt, tool: tool || null },
      ].slice(-50),
    };
    atomicWrite(file, st);
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
    // Guarda por PRESENÇA de mudança, não por contagem de chaves: o .json do
    // Kiro nasce depois do .jsonl — no 1º evento o enrich lança (engolido), o
    // writeState grava com cwd:null, e nos próximos a contagem já bateria e o
    // cwd real NUNCA chegaria (linha exibe o rótulo fallback "... · PID").
    if (meta.cwd)        enriched.cwd        = meta.cwd;
    if (meta.session_id) enriched.session_id = meta.session_id;
    const changed =
      (meta.cwd && enriched.cwd !== ex.cwd) ||
      (meta.session_id && enriched.session_id !== ex.session_id);
    if (changed) atomicWrite(stateFile, enriched);
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
// Map: sid → ms do último crescimento do .jsonl (base da síntese de Stop)
const _lastSeen = new Map();

function handleJsonl(sid) {
  const jsonlFile = path.join(KIRO_SESSIONS_DIR, `${sid}.jsonl`);
  try {
    const stat = fs.statSync(jsonlFile);
    const prevSize = _jsonlSizes.get(sid) || 0;
    // Ignora apenas STAGNAÇÃO (tamanho igual). O Kiro compacta/reescreve o
    // .jsonl (/clear, crash-recovery, rotação): se o arquivo ENCOLHEU, re-lemos
    // normal — com `<=` a sessão ficava surda pra sempre após uma compactação.
    if (stat.size === prevSize) return;
    _jsonlSizes.set(sid, stat.size);
    _lastSeen.set(sid, Date.now());
  } catch { return; }

  const kind = lastJsonlEvent(sid);
  const evt  = toCanonical(kind);
  if (!evt) return;

  // Lê .lock ANTES do primeiro writeState para garantir pid no state file
  // e evitar race com process discovery (duas linhas pro mesmo pid).
  const lock = readLock(sid);

  // Sem pid (jsonl nasceu antes do .lock) NÃO grava: uma linha pid:null é
  // invisível pra dedup do readSessions (exige agent+pid), vira zumbi que o
  // reapDead() ignora e desvia do filtro do lock no discovery (linha duplicada).
  // O handleLock(add) que vem em seguida cria o state com o pid do lock.
  if (!lock && !readState(sid).pid) return;

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
      atomicWrite(stateFile, ex);
    }
  }

  writeState(sid, evt, null);
}

function handleLock(sid, exists) {
  if (exists) {
    // Nova sessão ou re-apareceu — garante state file com pid do lock
    _lastSeen.set(sid, Date.now());
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
      atomicWrite(stateFile, st);

      // Avisa o main para invalidar cache de discovery imediatamente
      if (_onFirstWrite) _onFirstWrite();
    }
  } else {
    // Lock sumiu → sessão encerrou
    _jsonlSizes.delete(sid);
    _lastSeen.delete(sid);
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
      _lastSeen.set(sid, Date.now());
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
let _staleTimer = null;

const PROCESSING = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

// Registra Stop em sessões cujo jsonl está quieto há STOP_AFTER_MS e cujo último
// evento ainda é de PROCESSAMENTO (turno aberto sem novo downstream). Após gravar,
// re-anchora lastSeen p/ não re-gravar Stop num loop de 30s; qualquer linha nova
// do jsonl derruba a síntese (volta a amarelo no próximo evento real).
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
  if (_watcher) return; // já rodando
  if (!fs.existsSync(KIRO_SESSIONS_DIR)) return; // Kiro não instalado

  _onFirstWrite = onFirstWrite || null;

  bootstrap();

  _watcher = chokidar.watch(KIRO_SESSIONS_DIR, {
    ignoreInitial:    true,
    depth:            0,         // só arquivos diretos, não subpastas
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });

  _staleTimer = setInterval(scanForStops, STALENESS_SCAN_MS);

  _watcher.on('all', (event, filePath) => {
    try {
      const sid = sidFromFile(filePath);
      if (!sid || !SAFE_ID.test(sid)) return;

      if (filePath.endsWith('.jsonl')) {
        if (event === 'change' || event === 'add') handleJsonl(sid);
      } else if (filePath.endsWith('.lock')) {
        if (event === 'add' || event === 'change') handleLock(sid, true);
        if (event === 'unlink')                    handleLock(sid, false);
      } else if (filePath.endsWith('.json')) {
        // .json consolidado re-escrito pelo Kiro a cada mensagem: re-enriquece
        // cwd/session_id (o add/change era descartado em silêncio, então o cwd
        // real nunca chegava ao state file).
        if (event === 'add' || event === 'change') enrichFromSessionJson(sid);
      }
    } catch {}
  });
}

function stop() {
  if (_watcher) { _watcher.close().catch(() => {}); _watcher = null; }
  if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
}

module.exports = { start, stop };
