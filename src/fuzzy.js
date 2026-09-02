// fuzzy.js — busca fuzzy da lista de sessões (#55).
//
// Zero dependências (o bundle não tem npm no renderer): subsequência própria,
// case-insensitive, com score por CONTIGUIDADE (letras seguidas da query
// achadas seguidas no texto valem mais que espalhadas) e BOUNDARY de palavra
// (casar no início do texto ou após separador vale mais que no meio de uma
// palavra). Quanto maior o score, melhor o match; -1 = não é subsequência.
//
// Export duplo: globals no browser (via <script> no index.html) e
// module.exports no Node (testes) — mesmo padrão de identity.js.

// Separadores que "quebram palavra" p/ o bônus de boundary: espaço, hífen,
// underscore, barra e ponto (nomes de projeto vêm de basename de cwd).
const WORD_SEP = /[\s\-_/.]/;

/**
 * Score fuzzy de `query` contra `text`.
 * @returns {number} -1 quando `text` não contém `query` como subsequência;
 *   senão score >= 0 (maior = melhor; query vazia = 0, match neutro).
 */
function fuzzyScore(query, text) {
  if (!query) return 0;
  if (!text) return -1;
  const q = query.toLowerCase();
  const t = String(text).toLowerCase();
  let ti = 0;        // cursor em t — os chars da query devem aparecer EM ORDEM
  let score = 0;
  let run = 0;       // comprimento da sequência contígua atual
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;              // espaços da query são flexíveis
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;           // falta um char → não é subsequência
    // Contiguidade: o char veio logo após o anterior (found === ti) estica o
    // run — "tra" em "traffic" (run 3) pontua mais que "tra" em "t|ra|ffic".
    run = (found === ti) ? run + 1 : 1;
    score += run;
    // Boundary: casar no início do texto ou colado num separador ("lig" em
    // "lights") vale mais que no meio de outra palavra ("lig" em "beligerante").
    if (found === 0 || WORD_SEP.test(t[found - 1])) score += 3;
    ti = found + 1;
  }
  return score;
}

/**
 * A sessão casa com a busca? Campos pesquisáveis: label (apelido >
 * basename do cwd — o MESMO nome que a linha mostra, com alias aplicado),
 * máquina de origem (s.origin), modelo (s.model) e sessão tmux
 * (s.tmux_session). `label` vem pronto do renderer (labelFor).
 * @returns {boolean}
 */
function sessionMatches(query, s, label) {
  if (!query) return true;
  const sess = s || {};
  const fields = [label, sess.origin, sess.model, sess.tmux_session];
  return fields.some((f) => f && fuzzyScore(query, f) >= 0);
}

if (typeof module !== 'undefined') module.exports = { fuzzyScore, sessionMatches };
