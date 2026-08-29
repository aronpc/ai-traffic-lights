// sessions.js — lógica PURA de merge/dedup das sessões (issue: Tilix sumia).
// main.js faz o I/O (ler state dir + sondar /proc) e chama mergeSessions.
//
// POR QUE term_program NÃO é mais o gate de "é terminal":
// o Tilix (e outros) NÃO exportam TERM_PROGRAM — só TILIX_ID. O filtro antigo
// `.filter(s => s.term_program)` deletava essas sessões junto com processos
// headless. O gate correto de "interativo" já existe em outra camada:
//   • state file → o hook só dispara em sessão interativa (SessionStart etc.)
//   • sonda /proc → já filtra parent = shell (zsh/bash/...), o que exclui
//     daemons/MCP servers cujo parent é node/claude.
// Logo nenhuma filtragem extra por term_program é necessária.

const { sessionKey } = require('./identity.js');

// Dedupe por sessionKey (origin:pid||session_id) — 1 processo = 1 terminal =
// 1 linha. Mesmo pid com 2 session_ids (job roteando 2 contextos): mantém o
// evento mais recente. pid ausente: dedupe por session_id (nunca colide).
// O prefixo `origin` é o que IMPEDE a colisão entre máquinas: dois terminais
// em máquinas diferentes com o mesmo pid viram chaves distintas. Default
// 'local' quando a sessão vem sem origin (state file legado / sonda /proc).
function mergeSessions(stateFileSessions, discovered) {
  const sessions = (stateFileSessions || []).map((s) => (s.origin ? s : { ...s, origin: 'local' }));
  for (const { pid, agent } of discovered || []) {
    if (pid && !sessions.some((s) => s.pid === pid && originOfLocal(s))) {
      sessions.push({
        session_id: `proc-${pid}`, pid, agent, origin: 'local',
        cwd: null, term_program: 'terminal',
        last_event: 'ativo', last_event_ts: 0,
      });
    }
  }
  const byKey = new Map();
  for (const s of sessions) {
    const key = sessionKey(s);
    const prev = byKey.get(key);
    if (!prev || (s.last_event_ts || 0) >= (prev.last_event_ts || 0)) byKey.set(key, s);
  }
  return [...byKey.values()];
}
// helper local: sessão é local (não entrou como discovery duplicado de outra origem)
function originOfLocal(s) { return (s.origin || 'local') === 'local'; }

if (typeof module !== 'undefined') module.exports = { mergeSessions };
