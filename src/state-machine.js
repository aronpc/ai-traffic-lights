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
const REASON_FOR = {
  PermissionRequest: { level: 'awaiting', reason: 'permission' },
  PostToolUseFailure: { level: 'awaiting', reason: 'error' },
  Notification: { level: 'awaiting', reason: 'question' }, // TODO: filtrar "concluído" benigno (§7)
};

const PROCESSING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

// Ícone por motivo (sub-ícone ao lado do nome).
const REASON_ICON = {
  permission: '🔑', question: '❓', error: '⚠', idle: '⏰', tool: '🛠', ok: '✓',
};

/**
 * @param {object} state  state file parseado {last_event, last_event_ts, ...}
 * @param {number} nowSec  epoch atual (Date.now()/1000)
 * @param {object} [cfg]   {idleThresholdSec, escalateIdle} — configurável
 * @returns {{level:'processing'|'done'|'awaiting', reason:string|null}}
 */
function computeState(state, nowSec, cfg) {
  const last = state.last_event;
  const escalate = cfg ? cfg.escalateIdle : DEFAULT_ESCALATE_IDLE;
  const threshold = cfg ? cfg.idleThresholdSec : DEFAULT_IDLE_THRESHOLD_SEC;

  // 1. Razões explícitas de "precisa de você" (vermelho).
  if (REASON_FOR[last]) return REASON_FOR[last];

  // 2. Processando (amarelo).
  if (PROCESSING_EVENTS.has(last)) return { level: 'processing', reason: 'tool' };

  // 3. Terminado (verde) — com escalada idle opcional.
  if (last === 'Stop' || last === 'SessionStart' || last === 'SessionEnd') {
    const ageSec = nowSec - (state.last_event_ts || 0);
    if (escalate && last === 'Stop' && ageSec > threshold) {
      return { level: 'awaiting', reason: 'idle' };
    }
    return { level: 'done', reason: 'ok' };
  }

  // 4. Evento desconhecido → conservador verde.
  return { level: 'done', reason: null };
}

function iconFor(st) {
  return REASON_ICON[st.reason] || (st.level === 'processing' ? '🛠' : '✓');
}

// ---- ordenação por urgência (vermelhos no topo) ----
// Rank: awaiting (🔴) < processing (🟡) < done (🟢). Mesmo nível:
//  · awaiting  → mais antiga primeiro (quem espera há mais tempo é mais urgente)
//  · demais    → mais recente primeiro (atividade nova visível)
const URGENCY_RANK = { awaiting: 0, processing: 1, done: 2 };
function sortByUrgency(ranked) {
  return [...ranked].sort((a, b) => {
    const la = (a.st && a.st.level) || 'done';
    const lb = (b.st && b.st.level) || 'done';
    if (la !== lb) return URGENCY_RANK[la] - URGENCY_RANK[lb];
    const at = (a.s && a.s.last_event_ts) || 0;
    const bt = (b.s && b.s.last_event_ts) || 0;
    return la === 'awaiting' ? at - bt : bt - at;
  });
}

if (typeof module !== 'undefined') module.exports = { computeState, iconFor, sortByUrgency };
