// read-marks.js — estado persistente das marcas de leitura (#56).
//
// Antes do sync, `readMarks` vivia só no renderer (Map em memória) e morria no
// restart; e marcas vindas de OUTRA máquina não existiam. Este módulo é o lado
// MAIN da coisa: carga/gravação de `read-marks.json` no BASE_DIR (padrão de
// aliases.json/window.json) + merge LWW.
//
//   { 'local:1234': 1730000000, ... }   // chave → readAt (epoch segundos)
//
// LWW (last-write-wins): para cada chave, o MAIOR readAt vence — explícito,
// porque é a única regra que fecha com clocks independentes: regravar uma marca
// mais velha NUNCA pode "des-ler" uma sessão. Módulo puro (sem Electron) —
// main.js só orquestra; a lógica é testável direto no node:test.

const fs = require('fs');

// Carrega o estado do disco. Arquivo ausente/corrompido → {} (uma marca de
// leitura perdida é degradável: a sessão só volta a ficar "não lida").
function loadReadMarks(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof k === 'string' && k && Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

// Grava o estado. Marcas são eventos RAROS (clique/PPOST de peer), então write
// direto sem debounce — diferente de usage.json (ciclo de 60s), não há churn.
function saveReadMarks(file, state) {
  try { fs.writeFileSync(file, JSON.stringify(state || {})); return true; } catch { return false; }
}

// Merge LWW de marks: [{key, readAt}] (já saneadas pela rede — net.js
// valida tipos; aqui confiamos mas NÃO rebaixamos: readAt <= 0 é pulado).
// Retorna { state, applied } — `applied` SÓ as marcas que mudaram algo (o
// caller empurra essas ao renderer; as demais nem re-renderizam).
function applyMarks(state, marks) {
  const out = { ...(state || {}) };
  const applied = [];
  if (!Array.isArray(marks)) return { state: out, applied };
  for (const m of marks) {
    if (!m || typeof m.key !== 'string' || !m.key) continue;
    const at = Math.floor(Number(m.readAt));
    if (!Number.isFinite(at) || at <= 0) continue;
    // LWW: marca mais VELHA nunca regride uma mais nova já aplicada.
    if ((out[m.key] || 0) >= at) continue;
    out[m.key] = at;
    applied.push({ key: m.key, readAt: at });
  }
  return { state: out, applied };
}

module.exports = { loadReadMarks, saveReadMarks, applyMarks };
