// identity.js — identidade de LINHA cross-máquina (fase 1 do sync P2P).
//
// A chave de "1 processo = 1 terminal = 1 linha do overlay" precisa ser
// namespaced por ORIGEM (máquina), porque `pid`/`session_id` COLIDEM entre
// máquinas — as duas têm pid 1234, e o fallback `proc-<pid>` também colide.
// Sem isso, sessões remotas (futuras) sobrescreveriam locais no dedup/Map.
//
//   origin: 'local' para sessões DESTA máquina; nome do peer p/ remotas.
//   sessionKey(s) = origin + ':' + (pid || session_id)   → dedup/snooze/render/readMarks
//
// Carregado em DOIS contextos:
//   • browser: <script src="identity.js"> no index.html (funções viram globais)
//   • Node:    require('./identity.js') em sessions.js / main.js / agent.js (futuro)
// Por isso declara as funções no top-level (global em script clássico) e só
// exporta via module.exports quando module existe (Node).

function originOf(s) {
  return (s && s.origin) || 'local';
}

// Chave da LINHA — nunca o cwd, nunca o pid/session_id isolados. String estavel
// p/ usar em Map/Set e em JSON. Vazia só se a sessão vier sem pid E sem session_id.
function sessionKey(s) {
  if (!s) return '';
  return originOf(s) + ':' + (s.pid || s.session_id || '');
}

if (typeof module !== 'undefined') module.exports = { originOf, sessionKey };
