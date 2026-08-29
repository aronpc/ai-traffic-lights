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
  try {
    io.writeFileSync(`${stateFile}.tmp`, JSON.stringify(obj));
    io.renameSync(`${stateFile}.tmp`, stateFile);
    return true;
  } catch { return false; }
}

// Campos que pertencem a OUTRO escritor e que um evento nunca deve zerar:
//   transcript_path — vem do backfillModels() do overlay
//   windowid/focus_url/tilix_id/iterm_id/zellij_session — click-to-focus
//   cwd/model/term_program — enriquecimento que o evento pode não carregar
const PRESERVADOS = [
  'cwd', 'model', 'transcript_path', 'term_program',
  'windowid', 'focus_url', 'tilix_id', 'iterm_id', 'zellij_session',
  'notification_type', 'tmux_pane', 'tmux_session',
];

// Funde o state existente com o patch do evento. Três garantias:
//   1. chaves de TERCEIROS sobrevivem (um adapter não sabe o que os outros
//      escreveram — apagar o que não entende é o erro clássico);
//   2. os campos de PRESERVADOS só mudam se o patch trouxer valor não-nulo;
//   3. `events` é append-only com teto de 50.
function mergeState(existente, patch, evento) {
  const ex = (existente && typeof existente === 'object') ? existente : {};
  const out = { ...ex, ...patch };
  for (const k of PRESERVADOS) {
    if (patch[k] === undefined || patch[k] === null) {
      if (ex[k] !== undefined) out[k] = ex[k];
      else if (!(k in out)) out[k] = null;
    }
  }
  if (evento) {
    const antes = Array.isArray(ex.events) ? ex.events : [];
    out.events = [...antes, evento].slice(-50);
  }
  return out;
}

module.exports = { atomicWrite, mergeState, PRESERVADOS };
