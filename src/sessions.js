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

// Dedupe por pid (1 processo = 1 terminal = 1 linha). Mesmo pid com 2
// session_ids (job roteando 2 contextos): mantém o evento mais recente.
// pid ausente: dedupe por session_id (cabeça-de-série, nunca colide).
function mergeSessions(stateFileSessions, discovered) {
  const sessions = [...(stateFileSessions || [])];
  for (const { pid, agent } of discovered || []) {
    if (pid && !sessions.some((s) => s.pid === pid)) {
      sessions.push({
        session_id: `proc-${pid}`, pid, agent,
        cwd: null, term_program: 'terminal',
        last_event: 'ativo', last_event_ts: 0,
      });
    }
  }
  const byPid = new Map();
  for (const s of sessions) {
    const key = s.pid || s.session_id;
    const prev = byPid.get(key);
    if (!prev || (s.last_event_ts || 0) >= (prev.last_event_ts || 0)) byPid.set(key, s);
  }
  return [...byPid.values()];
}

if (typeof module !== 'undefined') module.exports = { mergeSessions };
