// state-writer.js — escrita do state file para quem roda DENTRO do overlay.
//
// Só serve os escritores in-process (adapters/kiro, collect.js). Os outros dois
// escritores do contrato são duplicados por NECESSIDADE, não por desleixo:
//   • hooks/traffic-hook.sh   — bash, roda no processo do agente
//   • adapters/opencode/…     — copiado para ~/.config/opencode/plugin/ e
//                               carregado pelo OpenCode; não alcança este repo
// Qualquer um dos dois teria de embutir uma cópia de qualquer forma.
//
// O que este módulo existe para garantir é a regra de ouro do contrato, que até
// aqui vivia só em prosa (docs/ARCHITECTURE.md, "Preserve, don't regress") e por
// isso foi violada — o adapter do Kiro apagava `transcript_path` e os campos de
// foco a cada evento (achado 08 do review da PR #46). Regra em comentário é
// sugestão; regra em função com teste é contrato.

const fs = require('fs');

// tmp + rename: o leitor nunca enxerga um arquivo pela metade. Devolve bool em
// vez de lançar — um adapter jamais pode derrubar quem o hospeda.
//
// `fsImpl` existe porque o adapter do Kiro é carregado num vm com um `fs`
// mockado nos testes: sem receber o fs de quem chama, este módulo escreveria no
// disco de verdade e o teste deixaria de isolar o que diz isolar.
function atomicWrite(stateFile, obj, fsImpl) {
  const io = fsImpl || fs;
  const tmp = `${stateFile}.tmp`;
  try {
    io.writeFileSync(tmp, JSON.stringify(obj));
    io.renameSync(tmp, stateFile);
    return true;
  } catch {
    // O rename pode falhar com o payload JÁ escrito (EACCES/EROFS/EBUSY no
    // alvo). Sem isto o .tmp fica órfão para sempre: os leitores filtram
    // `.json` e não o veem, então ninguém o recolhe.
    try { io.unlinkSync(tmp); } catch {}
    return false;
  }
}

// Campos que pertencem a OUTRO escritor e que um evento nunca deve zerar:
//   transcript_path — vem do backfillModels() do overlay
//   windowid/focus_url/tilix_id/iterm_id/zellij_session — click-to-focus
//   cwd/model/term_program — enriquecimento que o evento pode não carregar
const PRESERVADOS = [
  'cwd', 'model', 'transcript_path', 'term_program',
  'windowid', 'focus_url', 'tilix_id', 'iterm_id', 'zellij_session',
  'tmux_pane', 'tmux_session',
];

// `notification_type` fica DE FORA de propósito. O contrato (docs/ARCHITECTURE.md)
// diz "null a menos que last_event == Notification", e o hook o reescreve a cada
// evento justamente para isso. Preservá-lo o deixaria grudento: um Stop depois de
// um permission_prompt manteria o discriminador antigo, e o computeState
// classificaria a PRÓXIMA notificação sem tipo pelo tipo da anterior.

// Funde o state existente com o patch do evento. Três garantias:
//   1. chaves de TERCEIROS sobrevivem (um adapter não sabe o que os outros
//      escreveram — apagar o que não entende é o erro clássico);
//   2. os campos de PRESERVADOS só mudam se o patch trouxer valor não-nulo;
//   3. `events` é append-only com teto de 50.
function mergeState(existente, patch, evento) {
  const ex = (existente && typeof existente === 'object') ? existente : {};
  // O patch também é guardado: dentro do adapter isto roda sob um catch cego, e
  // um TypeError aqui faria o evento sumir sem deixar rastro. Um módulo que
  // existe para não derrubar o host não pode ter porta de entrada que lança.
  const pt = (patch && typeof patch === 'object') ? patch : {};
  const out = { ...ex, ...pt };
  for (const k of PRESERVADOS) {
    if (pt[k] === undefined || pt[k] === null) {
      if (ex[k] !== undefined) out[k] = ex[k];
      else if (!(k in out)) out[k] = null;
    }
  }
  // O contrato é explícito: `notification_type` é null a menos que o evento
  // ATUAL seja Notification. Tirá-lo de PRESERVADOS não bastava — o spread do
  // state existente o carregava assim mesmo, e o discriminador da notificação
  // anterior classificaria a próxima (computeState decide por este campo).
  if (out.last_event !== 'Notification') out.notification_type = null;

  if (evento) {
    const antes = Array.isArray(ex.events) ? ex.events : [];
    out.events = [...antes, evento].slice(-50);
  }
  return out;
}

module.exports = { atomicWrite, mergeState, PRESERVADOS };
