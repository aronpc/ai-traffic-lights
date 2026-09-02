// state-machine.js — computa o estado do semáforo a partir do state file.
//
// POR QUE ISSO RODA NO RENDERER (e não no hook): a escalada idle (verde→vermelho
// após N min) exige comparar o timestamp do último Stop com o AGORA. O hook é
// event-driven (sem relógio); só o renderer tem um setInterval pra reavaliar.
//
// Decisões (plano §6): 3 cores. Erro = vermelho ⚠. Idle > N min escala p/ vermelho.
// `reason` é o sub-ícone (motivo), não uma cor nova.

// Defaults da escalada idle — sobrescritos pelo cfg de computeState quando o
// usuário configura (ver src/settings.js + janela de Preferências).
const DEFAULT_IDLE_THRESHOLD_SEC = 5 * 60;  // verde→vermelho após 5 min parado
const DEFAULT_ESCALATE_IDLE = true;         // toggle (plano §6, opção c)

// Mapa evento → {level, reason}. Razões explícitas (awaiting) vêm primeiro.
// Notification NÃO está aqui — é classificado por notification_type abaixo
// (auth_success / elicitation_complete / elicitation_response são benignos).
const REASON_FOR = {
  PermissionRequest: { level: 'awaiting', reason: 'permission' },
  Question: { level: 'awaiting', reason: 'question' },
  PostToolUseFailure: { level: 'awaiting', reason: 'error' },
};

// Tipos de Notification que NÃO precisam do usuário (docs do Claude Code):
//   auth_success            — autenticação deu certo
//   elicitation_complete    — fluxo de elicitação do MCP terminou
//   elicitation_response    — usuário respondeu a uma elicitação
// Os demais (permission_prompt, idle_prompt, elicitation_dialog) são 🔴.
// Classifica pelo notification_type, NUNCA por substring da message
// (instável entre versões e sujeito a i18n).
const BENIGN_NOTIFICATION_TYPES = new Set(['auth_success', 'elicitation_complete', 'elicitation_response']);

const PROCESSING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

// Ícone por motivo (sub-ícone ao lado do nome).
const REASON_ICON = {
  permission: '🔑', question: '❓', error: '⚠', idle: '⏰', tool: '🛠', ok: '✓',
};

/**
 * @param {object} state  state file parseado {last_event, last_event_ts, ...}
 * @param {number} nowSec  epoch atual (Date.now()/1000)
 * @param {object} [cfg]   {idleThresholdSec, escalateIdle} — configurável
 * @param {number} [readAt]  ts (epoch s) até o qual a sessão foi marcada LIDA.
 *   Se a sessão estaria 'awaiting' mas o último evento é <= readAt (nenhuma
 *   notificação nova desde a marca), rebaixa para 'read' (cinza). Um evento
 *   vermelho com last_event_ts > readAt reacende naturalmente.
 * @returns {{level:'processing'|'done'|'awaiting'|'read', reason:string|null}}
 */
function computeState(state, nowSec, cfg, readAt) {
  const st = baseState(state, nowSec, cfg);
  // "Marcar como lido": só rebaixa vermelhos (awaiting) e só se a marca cobre o
  // evento atual. Amarelo/verde nunca viram cinza. O readAt é por-sessão.
  if (st.level === 'awaiting' && typeof readAt === 'number'
      && (state.last_event_ts || 0) <= readAt) {
    return { level: 'read', reason: st.reason };
  }
  return st;
}

function baseState(state, nowSec, cfg) {
  const last = state.last_event;
  const escalate = cfg ? cfg.escalateIdle : DEFAULT_ESCALATE_IDLE;
  const threshold = cfg ? cfg.idleThresholdSec : DEFAULT_IDLE_THRESHOLD_SEC;

  // 1. Notification: classifica pelo notification_type (benigno → verde).
  if (last === 'Notification') {
    if (state.notification_type && BENIGN_NOTIFICATION_TYPES.has(state.notification_type)) {
      return { level: 'done', reason: 'ok' };
    }
    return { level: 'awaiting', reason: 'question' };
  }

  // 2. Razões explícitas de "precisa de você" (vermelho).
  if (REASON_FOR[last]) return REASON_FOR[last];

  // 3. Processando (amarelo).
  if (PROCESSING_EVENTS.has(last)) return { level: 'processing', reason: 'tool' };

  // 4. Terminado (verde) — com escalada idle opcional.
  if (last === 'Stop' || last === 'SessionStart' || last === 'SessionEnd') {
    const ageSec = nowSec - (state.last_event_ts || 0);
    if (escalate && last === 'Stop' && ageSec > threshold) {
      return { level: 'awaiting', reason: 'idle' };
    }
    return { level: 'done', reason: 'ok' };
  }

  // 5. Evento desconhecido → conservador verde.
  return { level: 'done', reason: null };
}

function iconFor(st) {
  if (st.level === 'read') return '👁';                 // lido (silenciado até nova notificação)
  return REASON_ICON[st.reason] || (st.level === 'processing' ? '🛠' : '✓');
}

// ---- ordenação por urgência (vermelhos no topo) ----
// Rank: awaiting (🔴) < processing (🟡) < done (🟢) < read (cinza, resolvido).
// Dentro do mesmo nível NÃO há ordenação por tempo (mais antiga/espera há mais
// tempo): a chave é ESTÁVEL — local antes de peers, peers em ordem alfabética,
// depois id da sessão. Ordenar por last_event_ts faria a lista reordenar a cada
// tool call (~2s), confundindo local/remoto e causando mis-click no topo.
const URGENCY_RANK = { awaiting: 0, processing: 1, done: 2, read: 3 };
// opts.originFirst (modo agrupado, #54): ORIGEM como chave primária (local antes,
// peers alfabéticos) e urgência DENTRO do bloco. Sem ela a urgência é primária —
// um peer 🔴 vem antes de local 🟢 — o que é o comportamento da lista plana, mas
// fragmentaria os blocos de host em vários pedaços (header repetido no meio).
function sortByUrgency(ranked, opts) {
  // Chave ESTÁVEL por id (não por last_event_ts, que muda a cada tool call e
  // faria a lista REORDENAR a cada ~2s — confundia local/remoto, causava
  // mis-click). A lista só muda quando a URGÊNCIA muda.
  const skey = (x) => ((x.s && (x.s.session_id || x.s.pid)) || '');
  const originOf = (x) => ((x.s && x.s.origin) || 'local');
  const isLocal = (x) => { const o = originOf(x); return !o || o === 'local'; };
  const originFirst = !!(opts && opts.originFirst);
  const byOrigin = (a, b) => {
    // LOCAL (este host) sempre antes dos peers — evita mis-click e
    // agrupa a máquina do usuário no topo. Antes era string pura de origin, e
    // hostnames comuns ("alienware") ordenavam antes de "local" (PR-32 #20).
    const al = isLocal(a), bl = isLocal(b);
    if (al !== bl) return al ? -1 : 1;
    const oa = originOf(a), ob = originOf(b);
    if (oa !== ob) return oa < ob ? -1 : 1;   // peers: ordem alfabética estável
    return 0;
  };
  return [...ranked].sort((a, b) => {
    const la = (a.st && a.st.level) || 'done';
    const lb = (b.st && b.st.level) || 'done';
    if (originFirst) {
      const o = byOrigin(a, b);
      if (o) return o;
    }
    if (la !== lb) return URGENCY_RANK[la] - URGENCY_RANK[lb];
    if (!originFirst) {
      const o = byOrigin(a, b);
      if (o) return o;
    }
    const ka = skey(a), kb = skey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---- agrupamento por host (#54) ----
// Cortes de grupo de uma lista JÁ ordenada por sortByUrgency (que deixa as
// sessões contíguas por origem: local primeiro, peers alfabéticos). Cada corte
// descreve um bloco: {origin, startIdx, count, worst} — startIdx é o índice em
// `ordered` onde o bloco começa, worst o nível mais urgente dentro dele (p/ o
// header resumir "notebook-hg · 3 🔴"). Pura: o renderer decide se desenha.
function groupBreaks(ordered) {
  const breaks = [];
  let cur = null;
  for (let i = 0; i < ordered.length; i++) {
    const s = (ordered[i] && ordered[i].s) || {};
    const level = (ordered[i].st && ordered[i].st.level) || 'done';
    const origin = s.origin || 'local';
    if (!cur || cur.origin !== origin) {
      cur = { origin, startIdx: i, count: 0, worst: level };
      breaks.push(cur);
    }
    cur.count++;
    if (URGENCY_RANK[level] < URGENCY_RANK[cur.worst]) cur.worst = level;
  }
  return breaks;
}

if (typeof module !== 'undefined') module.exports = { computeState, iconFor, sortByUrgency, groupBreaks };
