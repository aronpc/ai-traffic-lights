// fuzzy.js — fuzzy search over the session list (#55).
//
// Zero dependencies (the renderer bundle has no npm): own subsequence
// implementation, case-insensitive, with a CONTIGUITY score (query letters
// found consecutive in the text are worth more than scattered ones) and a word
// BOUNDARY bonus (matching at the start of the text or after a separator is
// worth more than in the middle of a word). The higher the score, the better
// the match; -1 = not a subsequence.
//
// Dual export: globals in the browser (via <script> in index.html) and
// module.exports in Node (tests) — same pattern as identity.js.

// Separators that "break a word" for the boundary bonus: space, hyphen,
// underscore, slash and dot (project names come from the cwd basename).
const WORD_SEP = /[\s\-_/.]/;

/**
 * Fuzzy score of `query` against `text`.
 * @returns {number} -1 when `text` does not contain `query` as a subsequence;
 *   otherwise score >= 0 (higher = better; empty query = 0, neutral match).
 */
function fuzzyScore(query, text) {
  if (!query) return 0;
  if (!text) return -1;
  const q = query.toLowerCase();
  const t = String(text).toLowerCase();
  let ti = 0;        // cursor in t — the query chars must appear IN ORDER
  let score = 0;
  let run = 0;       // length of the current contiguous run
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;              // spaces in the query are flexible
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;           // a char is missing → not a subsequence
    // Contiguity: the char came right after the previous one (found === ti)
    // extends the run — "tra" in "traffic" (run 3) scores more than "tra" in "t|ra|ffic".
    run = (found === ti) ? run + 1 : 1;
    score += run;
    // Boundary: matching at the start of the text or right after a separator
    // ("lig" in "lights") is worth more than in the middle of another word ("lig" in "beligerante").
    if (found === 0 || WORD_SEP.test(t[found - 1])) score += 3;
    ti = found + 1;
  }
  return score;
}

/**
 * Does the session match the search? Searchable fields: label (nickname >
 * cwd basename — the SAME name the row shows, with alias applied),
 * origin machine (s.origin), model (s.model) and tmux session
 * (s.tmux_session). `label` comes ready from the renderer (labelFor).
 * @returns {boolean}
 */
function sessionMatches(query, s, label) {
  if (!query) return true;
  const sess = s || {};
  const fields = [label, sess.origin, sess.model, sess.tmux_session];
  return fields.some((f) => f && fuzzyScore(query, f) >= 0);
}

if (typeof module !== 'undefined') module.exports = { fuzzyScore, sessionMatches };
