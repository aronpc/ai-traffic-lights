// src/annotate.js — conta Claude de cada sessão LOCAL (#58 / modal de detalhes).
// Extraído do main para ser testável: resolve o rótulo da conta a partir do
// CLAUDE_CONFIG_DIR lido do environ do pid — a mesma descoberta de contas do
// claudeAccountsFromSessions, mas por sessão.
//
// O cache aqui é só do que NÃO muda na vida do processo (environ → dir); o
// RÓTULO é recomputado a cada chamada — apelido renomeado no tile da barra
// (account-labels.json) propaga no ciclo seguinte. Invariantes do cache
// (achados do review):
//  • pid → { sid, dir } só entra com environ LIDO: getEnviron devolve '' num
//    pid morto/race de exec → NÃO cacheia (o rótulo ficaria congelado na
//    conta default para sempre), tenta de novo no próximo ciclo;
//  • hit só vale com o MESMO session_id — pid reusado por outro processo
//    chega com sid diferente e re-lê o environ;
//  • pids fora do conjunto vivo são podados no fim da chamada.
// Anotação em memória: nada disso é gravado no state file. Remota (com
// origin) já chega anotada pelo peer — o rótulo é inofensivo (apelido/org/
// local-part, nunca email completo/uuid) e NÃO é LOCAL_ONLY.

function makeAnnotator({
  getEnviron,                      // (pid) → raw do environ ('' = ilegível)
  parseEnviron,                    // usage.parseEnviron
  readClaudeConfig,                // (dir) → config do perfil (cache mtime no usage)
  accountLabel,                    // usage.accountLabel
  apiProviderFromSettings,         // usage.apiProviderFromSettings
  agentOf,                         // agents.agentOf
  labelsFile,                      // ACCOUNT_LABELS_FILE (account-labels.json)
  fs,
}) {
  const pidDir = new Map();        // pid → { sid, dir }
  return function annotate(sessions) {
    if (!Array.isArray(sessions)) return sessions;
    const alive = new Set();
    let labels;                    // lazy: labelsFile 1x por ciclo (arquivo pequeno)
    for (const s of sessions) {
      // origin 'local' É truthy: o state file grava origin:'local' nas sessões
      // locais (o startRename do renderer usa o mesmo predicado).
      if (!s || (s.origin && s.origin !== 'local') || agentOf(s) !== 'claude' || !s.pid) continue;
      alive.add(s.pid);
      const sid = s.session_id || '';
      let dir;
      const hit = pidDir.get(s.pid);
      if (hit && hit.sid === sid) {
        dir = hit.dir;             // environ não muda: cache válido p/ o mesmo processo
      } else {
        // '' = ilegível (pid morreu / race de fork-exec / ps falhou): NÃO
        // cacheia — o label null/default viraria permanente.
        const raw = getEnviron(s.pid);
        if (!raw) continue;
        try { dir = parseEnviron(raw, ['CLAUDE_CONFIG_DIR']).CLAUDE_CONFIG_DIR || null; }
        catch { continue; }
        pidDir.set(s.pid, { sid, dir });
      }
      // Rótulo resolve TODA chamada (cache só do dir): rename no tile muda o
      // account-labels.json e o modal de detalhes vê no próximo ciclo.
      let label = null;
      try {
        const pc = readClaudeConfig(dir);
        if (labels === undefined) {
          try { labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')) || {}; } catch { labels = {}; }
        }
        // Chave de identidade: ORG primeiro (#60 — mesmo login em duas orgs
        // Team são contas com limite/billing independentes), accountUuid só p/
        // contas pessoais. Fallback labels[accountUuid]: apelido gravado antes
        // da chave de org continuar funcionando.
        const key = (pc && (pc.accountOrgUuid || pc.accountUuid)) || dir || 'default';
        const manual = labels[key] || (pc && pc.accountUuid && labels[pc.accountUuid]) || null;
        label = accountLabel(pc, dir, manual);
      } catch {}
      // API alternativa do perfil (settings.json env.ANTHROPIC_BASE_URL):
      // sessão de perfil técnico (ex. gh-claude → proxy vm-contabo/GLM) mostra
      // "gh-claude · vm-contabo:20128" em vez do nome seco do dir — o host diz
      // QUAL API a sessão realmente usa. Perfis de org não têm base_url →
      // rótulo intacto. dir null (conta default do symlink) → sem provedor.
      const api = dir && apiProviderFromSettings(dir);
      if (label && api) label += ' · ' + api;
      if (label) s.account = label;
    }
    for (const pid of pidDir.keys()) if (!alive.has(pid)) pidDir.delete(pid);
    return sessions;
  };
}

module.exports = { makeAnnotator };
