// usage.js — coletores de CONSUMO/RESET por agente (feature: % no overlay).
//
// Dois regimes de fonte (ver decisão em /docs e no plano "caminho C"):
//   PASSIVO (arquivo local, sem rede) — só dá RESET: Claude via ~/.claude.json.
//   ATIVO  (chamada autenticada)      — dá % E reset: GLM via API de monitor.
//
// A lógica PURA (parse) fica separada do I/O (ler arquivo / HTTP) para que os
// testes operem sobre fixtures sem rede nem disco. As funções de I/O NUNCA
// lançam: falha vira { ..., error }. Um agente sem credencial/config é simply
// omitido do resultado — o overlay mostra só quem tem dado.
//
// Objeto canônico (uma entrada por "limite" — um agente pode ter vários):
//   {
//     id:         'glm-tokens' | 'glm-month' | 'claude-plan',
//     agent:      'glm' | 'claude',         // pega ícone/cor em AGENTS
//     title:      'Tokens (5h)',            // o que é este limite (curto)
//     usedPct:    23,                        // 0..100, ou null se desconhecido
//     resetAt:    '2026-07-10T19:47:09Z',   // ISO, ou null
//     resetInMin: 1234,                      // conveniência p/ a UI, ou null
//     extra:      '3 passes',               // info adicional opcional
//     source:     'claude.json' | 'glm.api',
//     error:      null | '<msg curta>',
//   }

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// ---- tradução de tier Claude Max → label humano ----
const CLAUDE_TIER_LABEL = {
  default_claude_max_5x: 'Max 5×',
  default_claude_max_20x: 'Max 20×',
};

// ---- tradução de organizationType → label humano (fallback quando o tier não é
// um dos Max conhecidos). Cobre contas Team/Pro/Enterprise cujo tier tem código
// interno opaco (ex.: default_raven) que não mapeamos individualmente. ----
const CLAUDE_ORG_LABEL = {
  claude_max: 'Claude Max',
  claude_team: 'Claude Team',
  claude_pro: 'Claude Pro',
  claude_enterprise: 'Claude Enterprise',
};

// =========================== LÓGICA PURA (parse) ===========================

// Extrai reset/plano/passes de um objeto .claude.json já parseado.
// `now` em ms. Devolve {usedPct:null, resetAt, resetInMin, plan, passes}.
// O % do ciclo do Claude Max NÃO fica persistido em disco (só em runtime da
// API Anthropic) → usedPct é sempre null aqui (honesto: não inventa número).
function parseClaudeConfig(cfg, now) {
  const out = { usedPct: null, resetAt: null, resetInMin: null, plan: null, passes: null };
  if (!cfg || typeof cfg !== 'object') return out;

  // reset do plano: cachedGrowthBookFeatures.tengu_saffron_lattice.planLimitsEndDate
  const saffron = ((cfg.cachedGrowthBookFeatures || {}).tengu_saffron_lattice) || {};
  if (saffron.planLimitsEndDate) out.resetAt = saffron.planLimitsEndDate;

  // plano: oauthAccount.organizationType / organizationRateLimitTier
  // Ordem: tier Max conhecido (mais específico) → tipo de org conhecido → org
  // presente mas desconhecida (rótulo genérico "Claude"). Só fica null quando
  // NÃO há conta OAuth alguma — aí o coletor omite o Claude do overlay.
  const acc = cfg.oauthAccount || {};
  if (acc.organizationRateLimitTier && CLAUDE_TIER_LABEL[acc.organizationRateLimitTier]) {
    out.plan = 'Claude ' + CLAUDE_TIER_LABEL[acc.organizationRateLimitTier];
  } else if (acc.organizationType && CLAUDE_ORG_LABEL[acc.organizationType]) {
    out.plan = CLAUDE_ORG_LABEL[acc.organizationType];
  } else if (acc.organizationType || acc.organizationUuid || acc.emailAddress) {
    // conta existe (algum campo de identidade), mas tipo/tier não mapeados →
    // não some do overlay; mostra o rótulo genérico.
    out.plan = 'Claude';
  }

  // passes restantes (free passes do plano)
  if (typeof cfg.passesLastSeenRemaining === 'number') out.passes = cfg.passesLastSeenRemaining;

  if (out.resetAt) {
    const ms = Date.parse(out.resetAt) - (now || Date.now());
    out.resetInMin = ms > 0 ? Math.round(ms / 60000) : 0;
  }
  return out;
}

// Extrai os limites de um payload /api/monitor/usage/quota/limit do GLM.
// Schema (mapeado do plugin oficial glm-plan-usage):
//   { limits: [
//     { type:'TOKENS_LIMIT', percentage:<N> },                        // 5h
//     { type:'TIME_LIMIT',   percentage:<N>, currentValue, usage }    // mensal
//   ]}
// `now` em ms. Devolve array de entradas canônicas (sem agent/id/source —
// quem chama adiciona o contexto do agente).
//
// Schema real do /api/monitor/usage/quota/limit (z.ai/bigmodel):
//   { code:200, success:true, data: { level:'pro',
//     limits: [
//       { type:'TIME_LIMIT',  percentage:<N>, currentValue, usage, remaining, nextResetTime:<ms>, usageDetails:[...] },
//       { type:'TOKENS_LIMIT', percentage:<N>, nextResetTime:<ms> },
//     ]}}
// `limits` pode vir na raiz (testes) ou dentro de `data` (API real) — ambos aceitos.
function parseGlmQuota(payload, now) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  const root = (payload.data && Array.isArray(payload.data.limits)) ? payload.data : payload;
  if (!root || !Array.isArray(root.limits)) return out;
  const nowMs = now || Date.now();
  for (const lim of root.limits) {
    if (!lim || typeof lim !== 'object') continue;
    const resetAt = pickReset(lim);
    const resetInMin = resetAt ? Math.max(0, Math.round((Date.parse(resetAt) - nowMs) / 60000)) : null;
    const pct = typeof lim.percentage === 'number' ? clampPct(lim.percentage) : null;
    if (lim.type === 'TOKENS_LIMIT') {
      out.push({ title: 'Tokens (5h)', usedPct: pct, resetAt, resetInMin, extra: null, level: root.level || null });
    } else if (lim.type === 'TIME_LIMIT') {
      // MCP/tools mensal (search-prime, web-reader, zread, ...).
      out.push({ title: 'MCP (mês)', usedPct: pct, resetAt, resetInMin, extra: formatUsage(lim.currentValue, lim.usage), level: root.level || null });
    }
  }
  return out;
}

// nextResetTime vem em MILISSEGUNDOS (epoch) no schema real. Fallback heurístico
// para campos em string (resetAt, reset_at, ...) caso o schema mude.
function pickReset(lim) {
  if (typeof lim.nextResetTime === 'number' && lim.nextResetTime > 0) {
    return new Date(lim.nextResetTime).toISOString();
  }
  for (const k of ['resetAt', 'reset_at', 'resetTime', 'reset_time', 'resetsAt', 'expiresAt', 'expireTime']) {
    if (typeof lim[k] === 'string') {
      const ms = Date.parse(lim[k]);
      if (!Number.isNaN(ms)) return lim[k];
    }
  }
  return null;
}

function formatUsage(current, total) {
  if (typeof current !== 'number' || typeof total !== 'number') return null;
  return `${fmt(current)}/${fmt(total)}`;
}
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function clampPct(n) { return Math.max(0, Math.min(100, Math.round(n))); }

// Extrai as janelas de uso do payload de api.anthropic.com/api/oauth/usage.
// Schema (confirmado em runtime 2026-07-07):
//   { five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at},
//     seven_day_opus:null|{...}, seven_day_sonnet:null|{...}, ... }
// utilization é 0..100 (%). resets_at é ISO. `planLabel` já resolvido pelo caller.
// Devolve [{title, usedPct, resetAt, resetInMin}] — só janelas presentes.
function parseAnthropicUsage(payload, now) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  const nowMs = now || Date.now();
  const windows = [
    { key: 'five_hour', title: '5 h' },
    { key: 'seven_day', title: '7 dias' },
  ];
  for (const w of windows) {
    const win = payload[w.key];
    if (!win || typeof win !== 'object' || typeof win.utilization !== 'number') continue;
    const resetAt = typeof win.resets_at === 'string' ? win.resets_at : null;
    const resetInMin = resetAt && !Number.isNaN(Date.parse(resetAt))
      ? Math.max(0, Math.round((Date.parse(resetAt) - nowMs) / 60000)) : null;
    out.push({ title: w.title, usedPct: clampPct(win.utilization), resetAt, resetInMin });
  }
  return out;
}

// Extrai as janelas de uso do rate_limits de um evento token_count do Codex.
// Schema (confirmado runtime 2026-07-07, ~/.codex/sessions/**/rollout-*.jsonl):
//   payload.rate_limits: {
//     primary:   { used_percent, window_minutes:300,   resets_at:<epoch s> },  // 5h
//     secondary: { used_percent, window_minutes:10080, resets_at:<epoch s> },  // 7d
//     plan_type: 'plus'|'pro'|...
//   }
// resets_at é epoch em SEGUNDOS (≠ Anthropic ISO, ≠ GLM ms). window_minutes
// nomeia a janela (300→"5 h", 10080→"7 dias", outro→"Nh"/"Nd"). `now` em ms.
function parseCodexRateLimits(rateLimits, now) {
  const out = [];
  if (!rateLimits || typeof rateLimits !== 'object') return out;
  const nowMs = now || Date.now();
  for (const key of ['primary', 'secondary']) {
    const w = rateLimits[key];
    if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number') continue;
    const resetAt = typeof w.resets_at === 'number' && w.resets_at > 0
      ? new Date(w.resets_at * 1000).toISOString() : null;
    const resetInMin = resetAt ? Math.max(0, Math.round((Date.parse(resetAt) - nowMs) / 60000)) : null;
    out.push({ title: windowTitle(w.window_minutes), usedPct: clampPct(w.used_percent), resetAt, resetInMin });
  }
  return out;
}

// Nomeia a janela pelo tamanho em minutos (Codex não rotula por nome).
function windowTitle(min) {
  if (min === 300) return '5 h';
  if (min === 10080) return '7 dias';
  if (typeof min !== 'number' || min <= 0) return 'janela';
  if (min % 1440 === 0) return (min / 1440) + ' dias';
  if (min % 60 === 0) return (min / 60) + ' h';
  return min + ' min';
}

// =========================== I/O ===========================

// Lê o .claude.json e devolve o objeto COMPLETO do parseClaudeConfig — plano,
// reset (planLimitsEndDate), resetInMin e passes — p/ o tile plano-só poder
// mostrar o reset mesmo sem a API OAuth (ex.: conta Team durante um 429). Barato,
// síncrono. Devolve null quando NÃO há conta OAuth (sem .claude.json ou sem
// campos de identidade) — distingue "sem Claude" de "Claude sem plano mapeado".
function readClaudeConfig({ home, now } = {}) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home || os.homedir(), '.claude.json'), 'utf8'));
    const parsed = parseClaudeConfig(cfg, now || Date.now());
    return parsed.plan ? parsed : null;   // sem conta (plan null) → null
  } catch { return null; }
}

// Lê o OAuth access token do Claude Code de ~/.claude/.credentials.json
// (claudeAiOauth.accessToken). É o mesmo token que o próprio Claude Code usa;
// não gravamos nem renovamos — se estiver expirado, a API rejeita e caímos no
// fallback plano-só (o Claude Code renova sozinho no uso normal). Nunca lança.
function readClaudeOAuthToken({ home } = {}) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(home || os.homedir(), '.claude/.credentials.json'), 'utf8'));
    const t = creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
}

// Coletor do Claude. Tenta a API OAuth de uso (% E reset REAIS das janelas 5h e
// 7 dias — o mesmo dado do painel/`/status`); se não houver token ou a chamada
// falhar, cai no fallback: uma linha só com o plano (sem número, honesto).
// Cache por token, 30s. Nunca lança.
//
// 429 (rate limit): a API manda Retry-After (ex.: ~1000s). Rebater a cada 60s
// RENOVA a penalidade e o % nunca volta — foi o bug do "Claude sumiu". Ao levar
// 429 agendamos um cooldown (respeitando Retry-After) durante o qual NÃO batemos
// na API: devolvemos o último valor bom conhecido, ou o plano-só. Assim o tile
// não some nem pisca ⚠ e a janela de rate limit expira sozinha.
const _claudeCacheByToken = new Map(); // token → { at, entries, cooldownUntil }
async function readClaudeUsage({ home, now, fetcher, cooldownUntil, cooldownFails, setCooldown } = {}) {
  const pc = readClaudeConfig({ home, now });
  const plan = pc ? pc.plan : null;
  const token = readClaudeOAuthToken({ home });
  // Tile plano-só: mostra o reset (planLimitsEndDate) e passes mesmo sem a API
  // OAuth — assim a conta Team exibe "3d" durante um 429, em vez de campo vazio.
  const planOnly = plan
    ? [{ id: 'claude-plan', agent: 'claude', plan, title: null, usedPct: null,
        resetAt: pc.resetAt, resetInMin: pc.resetInMin,
        extra: (pc.passes != null ? pc.passes + ' passes' : null),
        source: 'claude.json', error: null }]
    : null;
  if (!token) return planOnly;

  const nowMs = now || Date.now();
  const cached = _claudeCacheByToken.get(token);
  if (cached && (nowMs - cached.at) < CLAUDE_CACHE_MS) return cached.entries;
  // Cooldown PERSISTIDO (injetado pelo main.js, sobrevive a restart): sem isto,
  // `bun start`/dev perde o cooldown em memória a cada reinício, re-bate no boot
  // e RE-ESCALA o 429 (o servidor sobe o Retry-After a cada toque). Não rebate.
  const cd = Math.max(cached && cached.cooldownUntil || 0, cooldownUntil || 0);
  if (cd && nowMs < cd) return (cached && cached.entries) || planOnly;

  const headers = {
    Authorization: 'Bearer ' + token,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    'User-Agent': 'ai-traffic-lights',
  };
  let payload;
  try {
    payload = await _httpsGetJson('https://api.anthropic.com/api/oauth/usage', headers, fetcher);
  } catch (e) {
    // 429 → backoff exponencial: cada 429 seguido alonga a espera (Retry-After ×
    // 1.5^fails, teto 1h) p/ dar espaço ao limite agregado recuperar. Mantém o
    // último valor bom (ou plano-só). Outras falhas (401/offline) → plano-só.
    if (e && e.statusCode === 429) {
      const baseMs = (typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0)
        ? e.retryAfterMs : CLAUDE_429_COOLDOWN_MS;
      const fails = (cached && cached.fails) || (cooldownFails || 0);
      const backoff = Math.min(CLAUDE_429_MAX_BACKOFF_MS,
        Math.round(baseMs * Math.pow(CLAUDE_429_BACKOFF_FACTOR, fails)));
      const until = nowMs + backoff;
      const keep = (cached && cached.entries) ? cached.entries : planOnly;
      _claudeCacheByToken.set(token, { at: nowMs, entries: keep, cooldownUntil: until, fails: fails + 1 });
      // Persiste {until, fails} (só timestamps/contador, nunca o token) p/ restart.
      if (typeof setCooldown === 'function') { try { setCooldown({ until, fails: fails + 1 }); } catch { /* nunca quebra a coleta */ } }
      return keep;
    }
    return planOnly; // token expirado/offline → plano-só (não polui com ⚠)
  }
  const windows = parseAnthropicUsage(payload, nowMs);
  if (!windows.length) return planOnly;
  const entries = windows.map((w) => ({
    id: 'claude-' + (w.title === '5 h' ? '5h' : '7d'),
    agent: 'claude',
    title: w.title,
    plan,
    usedPct: w.usedPct,
    resetAt: w.resetAt,
    resetInMin: w.resetInMin,
    extra: null,
    source: 'anthropic.oauth',
    error: null,
  }));
  _claudeCacheByToken.set(token, { at: nowMs, entries, fails: 0 });
  // Sucesso → zera o backoff persistido (libera p/ futuras coletas normais).
  if (typeof setCooldown === 'function') { try { setCooldown({ until: 0, fails: 0 }); } catch { /* nunca quebra a coleta */ } }
  return entries;
}
function _clearClaudeCache() { _claudeCacheByToken.clear(); }


// ---- Codex (OpenAI, plano ChatGPT) — PASSIVO, sem rede ----
// O uso vive no rollout da sessão: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// O ÚLTIMO evento token_count tem payload.rate_limits (% e reset reais das
// janelas 5h/semanal). Associamos o rollout à sessão viva pelo cwd (o
// session_meta do rollout tem cwd; o main.js passa o cwd lido de /proc/<pid>/cwd).
// Tudo injetável (sessionsDir, readFile, listFiles) → testável sem disco.

// Acha o caminho do rollout mais recente cujo session_meta.cwd == cwd alvo.
// `files` é a lista de caminhos absolutos de rollouts (mais recente primeiro é
// ideal, mas ordenamos por mtime via statMtime). Puro-ish: I/O por callbacks.
function findCodexRollout(cwd, opts = {}) {
  const listFiles = opts.listFiles || defaultListRollouts;
  const readHead = opts.readHead || defaultReadHead;
  const statMtime = opts.statMtime || defaultMtime;
  let files;
  try { files = listFiles(opts.sessionsDir); } catch { return null; }
  if (!Array.isArray(files) || !files.length) return null;
  // ordena por mtime desc (rollout ativo é o mais recém-escrito)
  const sorted = files.map((f) => ({ f, m: statMtime(f) })).sort((a, b) => b.m - a.m);
  for (const { f } of sorted) {
    let head;
    try { head = readHead(f); } catch { continue; }   // 1ª linha = session_meta
    let meta;
    try { meta = JSON.parse(head); } catch { continue; }
    const mcwd = meta && (meta.payload ? meta.payload.cwd : meta.cwd);
    if (mcwd === cwd) return f;
  }
  return null;
}

// Extrai o rate_limits do ÚLTIMO token_count de um rollout já lido (string
// JSONL). Puro/testável. Devolve o objeto rate_limits ou null.
function lastCodexRateLimits(jsonl) {
  if (typeof jsonl !== 'string') return null;
  let found = null;
  for (const line of jsonl.split('\n')) {
    if (!line || line.indexOf('token_count') === -1) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // O evento é {type:'event_msg', payload:{type:'token_count', rate_limits}}.
    const p = o && o.payload;
    if (p && p.type === 'token_count' && p.rate_limits) {
      found = p.rate_limits; // sobrescreve → fica com o ÚLTIMO token_count
    }
  }
  return found;
}

// Lê o uso do Codex para um cwd. Cache por cwd, 30s. Nunca lança.
const _codexCacheByCwd = new Map(); // cwd → { at, entries }
function readCodexUsage({ cwd, now, sessionsDir, listFiles, readHead, readFull, statMtime } = {}) {
  if (!cwd) return null;
  const nowMs = now || Date.now();
  const cached = _codexCacheByCwd.get(cwd);
  if (cached && (nowMs - cached.at) < CACHE_MS) return cached.entries;

  const file = findCodexRollout(cwd, { sessionsDir, listFiles, readHead, statMtime });
  if (!file) return null;
  const read = readFull || defaultReadFull;
  let jsonl;
  try { jsonl = read(file); } catch { return null; }
  const rl = lastCodexRateLimits(jsonl);
  if (!rl) return null;
  const windows = parseCodexRateLimits(rl, nowMs);
  if (!windows.length) return null;
  const plan = rl.plan_type ? 'Codex ' + rl.plan_type.charAt(0).toUpperCase() + rl.plan_type.slice(1) : 'Codex';
  const entries = windows.map((w) => ({
    id: 'codex-' + (w.title === '5 h' ? '5h' : (w.title === '7 dias' ? '7d' : w.title.replace(/\s+/g, ''))),
    agent: 'codex',
    title: w.title,
    plan,
    usedPct: w.usedPct,
    resetAt: w.resetAt,
    resetInMin: w.resetInMin,
    extra: null,
    source: 'codex.rollout',
    error: null,
  }));
  _codexCacheByCwd.set(cwd, { at: nowMs, entries });
  return entries;
}
function _clearCodexCache() { _codexCacheByCwd.clear(); }

// I/O default do Codex (usados em produção; testes injetam os próprios).
function defaultListRollouts(dir) {
  const base = dir || path.join(os.homedir(), '.codex', 'sessions');
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}
function defaultMtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
function defaultReadHead(f) {
  // Lê só a 1ª linha (session_meta) — mas ela pode ser GRANDE: o Codex embute o
  // system prompt inteiro em payload.base_instructions (dezenas de KB). Lê em
  // blocos até o primeiro \n (com teto de segurança) em vez de um buffer fixo,
  // senão o JSON.parse quebra numa linha cortada no meio.
  const fd = fs.openSync(f, 'r');
  try {
    const CHUNK = 65536, MAX = 4 * 1024 * 1024; // teto 4MB p/ a 1ª linha
    let acc = '', pos = 0;
    const buf = Buffer.alloc(CHUNK);
    while (pos < MAX) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const s = buf.toString('utf8', 0, n);
      const nl = s.indexOf('\n');
      if (nl !== -1) { acc += s.slice(0, nl); return acc; }
      acc += s; pos += n;
    }
    return acc;
  } finally { fs.closeSync(fd); }
}
function defaultReadFull(f) { return fs.readFileSync(f, 'utf8'); }

// ---- Antigravity / Gemini CLI (Google Code Assist) ----
// PASSIVO, sem rede. Duas fontes:
//  1. RÓTULO: o modelo ativo em ~/.gemini/antigravity-cli/settings.json.
//  2. QUOTA ESGOTADA: os DBs de conversa (~/.gemini/antigravity-cli/conversations/
//     *.db) gravam a resposta de erro QUOTA_EXHAUSTED da API, que traz o
//     quotaResetTimeStamp (reset semanal). O Google NÃO expõe % contínuo — só
//     sabemos "esgotado" quando estoura. Então: com quota → só o rótulo (—);
//     esgotado → usedPct=100 (barra cheia/vermelha) + reset.
// Síncrona (não faz rede) → collectUsage a envolve num Promise.resolve.

// Parser puro: extrai o rótulo do objeto settings já lido. Testável.
function parseAntigravityTier(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const model = settings.model || settings.selectedModel || settings.defaultModel;
  if (!model || typeof model !== 'string') return { model: null };
  return { model };
}

// Parser puro: acha o QUOTA_EXHAUSTED com o MAIOR quotaResetTimeStamp num texto
// (o conteúdo bruto de um .db, lido como string). Devolve {resetAt} ISO ou null.
// Regex-based (o .db é binário/protobuf; os JSONs de erro ficam legíveis dentro).
function parseAntigravityQuota(dbText, now) {
  if (typeof dbText !== 'string') return null;
  // Ignora conversas de suporte técnico do próprio semáforo de IA que contêm
  // discussões do código de cota e geram falsos positivos de teste.
  if (dbText.includes('debug_usage.js') || dbText.includes('traffic-hook.sh')) {
    return null;
  }
  const nowMs = now || Date.now();
  let bestTs = 0, bestAt = null;
  const re = /"quotaResetTimeStamp"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(dbText))) {
    const tsStr = m[1];
    const ms = Date.parse(tsStr);
    if (Number.isNaN(ms)) continue;

    // Confirma se QUOTA_EXHAUSTED está próximo (limita a janela a 250 caracteres antes/depois)
    const idx = m.index;
    const start = Math.max(0, idx - 250);
    const end = Math.min(dbText.length, idx + 250);
    const context = dbText.slice(start, end);
    if (/"reason"\s*:\s*"QUOTA_EXHAUSTED"/.test(context)) {
      if (ms > bestTs) { bestTs = ms; bestAt = tsStr; }
    }
  }
  // só conta se o reset é no FUTURO (quota realmente esgotada agora).
  if (bestAt && bestTs > nowMs) return { resetAt: bestAt };
  return null;
}

// Lê o uso do Antigravity. Rótulo do settings.json + estado de quota dos DBs de
// conversa (o mais recente por mtime). Sem settings → null. Nunca lança.
// I/O injetável (readFile, listDbs, readDb, mtime) pra teste.
function readAntigravityUsage({ home, now, readFile, listDbs, readDb, mtime } = {}) {
  const base = path.join(home || os.homedir(), '.gemini', 'antigravity-cli');
  let settings;
  try {
    const raw = (readFile || ((f) => fs.readFileSync(f, 'utf8')))(path.join(base, 'settings.json'));
    settings = JSON.parse(raw);
  } catch { return null; } // sem Antigravity configurado
  const t = parseAntigravityTier(settings);
  if (!t) return null;

  // quota esgotada: checa DBs de conversa RECENTES (modificados nas últimas 2h).
  // DBs antigos podem conter erros de quota de um plano anterior que já foi
  // atualizado — não devem afetar o status atual.
  const QUOTA_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 horas
  let quota = null;
  try {
    const list = (listDbs || defaultListAntigravityDbs)(base);
    const stat = mtime || ((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
    const read = readDb || ((f) => fs.readFileSync(f, 'latin1'));
    const nowMs = now || Date.now();
    // Filtra apenas por modificados nas últimas 2h, ordenando pelos mais recentes.
    const candidates = list
      .map((f) => ({ f, m: stat(f) }))
      .filter(({ m }) => (nowMs - m) < QUOTA_MAX_AGE_MS)
      .sort((a, b) => b.m - a.m)
      .slice(0, 3);
    for (const { f } of candidates) {
      let txt;
      try { txt = read(f); } catch { continue; }
      const q = parseAntigravityQuota(txt, now);
      if (q) { quota = q; break; }
    }
  } catch { /* sem DBs / sem permissão → segue só com rótulo */ }

  const nowMs = now || Date.now();
  const plan = t.model ? 'Antigravity (' + t.model + ')' : 'Antigravity';
  if (quota) {
    const resetInMin = Math.max(0, Math.round((Date.parse(quota.resetAt) - nowMs) / 60000));
    return [{
      id: 'antigravity-quota', agent: 'antigravity', title: 'Cota', plan,
      usedPct: 100,                        // esgotado → barra cheia (vermelha)
      resetAt: quota.resetAt, resetInMin, extra: null,
      source: 'antigravity.quota', error: null,
    }];
  }
  return [{
    id: 'antigravity-plan', agent: 'antigravity', title: 'Cota', plan,
    usedPct: null,                         // com quota → sem número (só rótulo)
    resetAt: null, resetInMin: null, extra: null,
    source: 'antigravity.settings', error: null,
  }];
}

// Lista os .db de conversa do Antigravity (I/O default; testes injetam o seu).
function defaultListAntigravityDbs(base) {
  const dir = path.join(base, 'conversations');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => path.join(dir, f)); }
  catch { return []; }
}

// Converte o header Retry-After em ms. Aceita os dois formatos do HTTP: um
// número de SEGUNDOS ("1007") ou uma data HTTP ("Wed, 21 Oct 2026 07:28:00 GMT").
// `now` em ms (injetável p/ teste). Devolve ms >= 0, ou null se ilegível.
function parseRetryAfter(header, now) {
  if (header == null) return null;
  const s = String(header).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;   // delta-seconds
  const when = Date.parse(s);                             // HTTP-date
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - (now || Date.now()));
}

// Faz um GET HTTPS injetando um `fetcher` (testável). Em produção usa https.get.
// Devolve o JSON parseado ou lança (quem chama captura).
function _httpsGetJson(url, headers, fetcher, timeoutMs = 4000) {
  const fetch = fetcher || ((u, h, t) => new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const req = https.request(
      { hostname: parsed.hostname, port: 443, path: parsed.pathname + parsed.search, method: 'GET', headers: h },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 200) { resolve(data); return; }
          // Anexa metadados ao erro p/ o caller decidir backoff (429 → cooldown).
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          const ra = parseRetryAfter(res.headers && res.headers['retry-after']);
          if (ra != null) err.retryAfterMs = ra;
          reject(err);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(t, () => req.destroy(new Error('timeout')));
    req.end();
  }));
  return fetch(url, headers, timeoutMs).then((body) => JSON.parse(body));
}

// Lê a quota do GLM via API de monitor. Requer ANTHROPIC_BASE_URL (z.ai ou
// bigmodel) + ANTHROPIC_AUTH_TOKEN no env. Sem credencial → null (omitido).
// Cache POR TOKEN (não global): contas z.ai distintas em terminais distintos
// não se sobrescrevem no cache. `label`/`suffix` distinguem contas na UI quando
// há mais de uma (multi-conta); com 1 conta ficam vazios e o id fica canônico.
const CACHE_MS = 30 * 1000;
// O Claude tem cache PRÓPRIO e mais longo: a API /api/oauth/usage é fortemente
// rate-limited (Retry-After ~1000s) e as janelas são de 5h/7d — o % mal muda em
// minutos. 5 min = no máx. 12 req/h, tira a pressão do endpoint. (GLM segue 30s.)
const CLAUDE_CACHE_MS = 5 * 60 * 1000; // 5 min
// Cooldown padrão quando o 429 não traz Retry-After legível (fallback conservador).
const CLAUDE_429_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
// Backoff exponencial: a cada 429 SEGUIDO, o app espera cada vez mais antes de
// tentar (Retry-After × 1.5^fails), até o teto. Evita o ciclo "cooldown expira →
// rebater → 429 de novo → re-armar" que mantinha o limite agregado estourado (o
// mesmo endpoint é consultado pelo próprio Claude Code no /status). Teto de 1h.
const CLAUDE_429_BACKOFF_FACTOR = 1.5;
const CLAUDE_429_MAX_BACKOFF_MS = 60 * 60 * 1000;
const _glmCacheByToken = new Map(); // token → { at, entries }
async function readGlmUsage({ env, now, fetcher, label, suffix } = {}) {
  const E = env || process.env;
  const base = E.ANTHROPIC_BASE_URL || '';
  const token = E.ANTHROPIC_AUTH_TOKEN || '';
  if (!token || !base) return null;
  if (!/api\.z\.ai|bigmodel\.cn/.test(base)) return null; // backend não-GLM

  const nowMs = now || Date.now();
  const cached = _glmCacheByToken.get(token);
  if (cached && (nowMs - cached.at) < CACHE_MS) return cached.entries;

  const parsed = new URL(base);
  const domain = `${parsed.protocol}//${parsed.host}`;
  const quotaUrl = `${domain}/api/monitor/usage/quota/limit`;
  const headers = { Authorization: token, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' };
  const sfx = suffix ? ':' + suffix : '';       // id único por conta (renderer key)
  const planTag = label ? ' (' + label + ')' : ''; // rótulo humano da conta

  let payload;
  try {
    payload = await _httpsGetJson(quotaUrl, headers, fetcher);
  } catch (e) {
    const entry = {
      id: 'glm' + sfx, agent: 'glm', title: 'GLM' + planTag, usedPct: null, resetAt: null,
      resetInMin: null, extra: null, source: 'glm.api', error: String(e.message || e),
    };
    _glmCacheByToken.set(token, { at: nowMs, entries: [entry] });
    return [entry];
  }

  const parsedLimits = parseGlmQuota(payload, nowMs);
  const level = parsedLimits[0] && parsedLimits[0].level ? parsedLimits[0].level : null;
  const planBase = level ? 'GLM ' + level.charAt(0).toUpperCase() + level.slice(1) : 'GLM';
  const entries = parsedLimits.map((l) => ({
    id: (l.title.startsWith('MCP') ? 'glm-month' : 'glm-tokens') + sfx,
    agent: 'glm',
    title: l.title,
    plan: planBase + planTag,
    usedPct: l.usedPct,
    resetAt: l.resetAt,
    resetInMin: l.resetInMin,
    extra: l.extra,
    source: 'glm.api',
    error: null,
  }));
  // Sem limites parseados = payload com schema desconhecido. Ainda assim
  // devolvemos uma entrada "GLM" marcando que a conta existe (source ativo),
  // mas sem número — honesto, não inventa.
  const result = entries.length ? entries : [{
    id: 'glm' + sfx, agent: 'glm', title: 'GLM' + planTag, usedPct: null, resetAt: null,
    resetInMin: null, extra: null, source: 'glm.api', error: 'no limits parsed',
  }];
  _glmCacheByToken.set(token, { at: nowMs, entries: result });
  return result;
}

// Limpa o cache (testes / mudança de credencial).
function _clearGlmCache() { _glmCacheByToken.clear(); }

// =========================== ORQUESTRADOR ===========================

// Junta todas as fontes. Ordem estável: Claude (local) primeiro, GLM depois.
// `now` em ms. Sempre resolve (nunca rejeita) — erros viram entries ou omissão.
//
// GLM multi-conta: opts.glmCreds é uma lista de credenciais distintas (uma por
// conta z.ai) coletadas das IAs rodando —
//   [{ env:{ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN}, label?, suffix? }]
// Cada IA rodando tem seu consumo buscado com a credencial DELA; contas iguais
// (mesmo token) já vêm deduplicadas por quem monta a lista (main.js). Fallback:
// opts.env (uma credencial) mantém o contrato antigo/testes. Os GLM rodam em
// paralelo (Promise.all) — I/O de rede independente por conta.
async function collectUsage(opts = {}) {
  const out = [];

  const creds = Array.isArray(opts.glmCreds) && opts.glmCreds.length
    ? opts.glmCreds
    : (opts.env ? [{ env: opts.env }] : []);
  const multi = creds.length > 1;              // >1 conta → rotula cada bloco

  // Claude (OAuth) + todas as contas GLM em paralelo — I/O de rede independente.
  // Claude usa opts.claudeFetcher (separado do de GLM: cada API tem schema/mock
  // próprio; em teste sem claudeFetcher e sem token, o Claude cai no plano-só).
  const [claude, antigravity, ...glm] = await Promise.all([
    readClaudeUsage({
      home: opts.home, now: opts.now, fetcher: opts.claudeFetcher,
      cooldownUntil: opts.claudeCooldownUntil, cooldownFails: opts.claudeCooldownFails,
      setCooldown: opts.claudeSetCooldown,
    }).catch(() => null),
    Promise.resolve().then(() => readAntigravityUsage({ home: opts.home })).catch(() => null),
    ...creds.map((c) => readGlmUsage({
      env: c.env, now: opts.now, fetcher: opts.fetcher,
      label: multi ? c.label : undefined,
      suffix: multi ? c.suffix : undefined,
    }).catch(() => null)),                      // readGlmUsage já captura; dupla defesa
  ]);
  if (Array.isArray(claude)) out.push(...claude);
  if (Array.isArray(antigravity)) out.push(...antigravity);

  // Codex (passivo, sem rede): uma leitura por cwd distinto de sessão Codex viva.
  // opts.codexCwds = ['/home/x/proj', ...] (main.js coleta de /proc/<pid>/cwd).
  const codexCwds = [...new Set(Array.isArray(opts.codexCwds) ? opts.codexCwds.filter(Boolean) : [])];
  const multiCodex = codexCwds.length > 1;     // >1 projeto → distingue no rótulo
  for (const cwd of codexCwds) {
    let entries = null;
    try { entries = readCodexUsage({ cwd, now: opts.now, ...(opts.codexIO || {}) }); } catch { /* nunca quebra */ }
    if (!Array.isArray(entries)) continue;
    if (multiCodex) {                          // rotula pela pasta do projeto
      const proj = cwd.split('/').filter(Boolean).pop() || cwd;
      for (const e of entries) { e.plan = e.plan + ' · ' + proj; e.id = e.id + ':' + proj; }
    }
    out.push(...entries);
  }

  for (const r of glm) if (Array.isArray(r)) out.push(...r);
  return out;
}

// Janelas do "envelhecimento" de uma linha de uso (ms). Depois de STALE_MS sem
// atualização, a linha é marcada stale=true (a UI a pinta cinza). Depois de
// DROP_MS, some (sessão provavelmente fechou). Um valor bom NOVO zera o relógio.
const USAGE_STALE_MS = 4 * 60 * 1000;   // ~4 min → cinza
const USAGE_DROP_MS = 20 * 60 * 1000;   // ~20 min → remove

// Tile "resumo/degradado": representa um agente SEM janela concreta — o
// plano-só do Claude (claude.json, sem %) ou o GLM cujos limites não foram
// parseados / a chamada falhou. Não deve coexistir com tiles concretos
// (claude-5h/7d, glm-tokens/month) do mesmo agente: quando a coleta oscila
// entre OK (reais) e falha (fallback) entre ticks, isso evita "Claude Max" e
// "Claude Max 5× - 5 h" na mesma tela. (issue: overlay duplicando tiles às vezes.)
// glm:suffix é multi-conta; glm-tokens/month (com hífen) NÃO são resumo.
function isSummaryEntry(e) {
  if (!e || !e.id) return false;
  const id = String(e.id);
  return id === 'claude-plan' || id === 'antigravity-plan' || id === 'glm' || id.startsWith('glm:');
}

// Funde a coleta nova (fresh) com o estado anterior (prev), por `id`. Resolve o
// bug de "os contadores zeram quando o dado não vem": em vez de substituir tudo,
// mantém o ÚLTIMO valor bom de cada linha até chegar um novo. Regras por id:
//   • fresh tem valor bom (usedPct != null, sem error) → adota, fetchedAt=now, stale=false
//   • fresh veio ruim (null/error) mas prev tinha valor → mantém prev, marca stale se velho
//   • id só no prev (não veio nesta coleta) → mantém, marca stale/dropa por idade
//   • id novo sem valor → passa como veio (primeira aparição honesta)
// `now` em ms. Retorna a lista fundida (ordem: fresh primeiro, depois órfãos do
// prev que ainda não expiraram), cada item com fetchedAt e stale.
function mergeUsage(prev, fresh, now) {
  const nowMs = now || Date.now();
  const prevById = new Map();
  for (const p of (Array.isArray(prev) ? prev : [])) if (p && p.id) prevById.set(p.id, p);

  // Se a nova coleta traz o plano do Antigravity, limpa a cota esgotada do cache anterior.
  const freshIds = new Set((fresh || []).map((f) => f && f.id).filter(Boolean));
  if (freshIds.has('antigravity-plan')) {
    prevById.delete('antigravity-quota');
  }

  const seen = new Set();
  const out = [];

  const isGood = (e) => e && e.usedPct != null && !e.error;

  for (const f of (Array.isArray(fresh) ? fresh : [])) {
    if (!f || !f.id) { out.push(f); continue; }
    seen.add(f.id);
    const p = prevById.get(f.id);
    if (isGood(f)) {
      out.push({ ...f, fetchedAt: nowMs, stale: false });
    } else if (isGood(p)) {
      // coleta atual falhou pra esta linha, mas tínhamos um valor bom: mantém.
      const age = nowMs - (p.fetchedAt || nowMs);
      out.push({ ...p, stale: age >= USAGE_STALE_MS });
    } else {
      // nunca tivemos valor bom: passa o fresh como veio (honesto).
      out.push({ ...f, fetchedAt: f.fetchedAt || nowMs, stale: false });
    }
  }

  // Linhas que existiam antes mas NÃO vieram nesta coleta (coletor sumiu de vez
  // por um tick): mantém até DROP_MS, marcando stale após STALE_MS.
  for (const [id, p] of prevById) {
    if (seen.has(id)) continue;
    const age = nowMs - (p.fetchedAt || nowMs);
    if (age >= USAGE_DROP_MS) continue;               // muito velho → some
    if (!isGood(p)) continue;                          // nunca teve valor → não segura
    out.push({ ...p, stale: age >= USAGE_STALE_MS });
  }

  // Desduplicação semântica: um tile "resumo" (claude-plan / glm sem limites) é
  // redundante se já existe um tile concreto do mesmo agente (vindo do fresh ou
  // segurado como órfão bom acima). Surge quando a coleta oscila entre OK e
  // falha entre ticks — sem isto, resumo e concreto coexistem na mesma tela.
  const concreteAgents = new Set();
  for (const e of out) if (e && !isSummaryEntry(e) && e.agent) concreteAgents.add(e.agent);
  let deduped = concreteAgents.size
    ? out.filter((e) => !isSummaryEntry(e) || !concreteAgents.has(e.agent))
    : out;

  // Dedup por CONTEÚDO (mesma conta, tokens diferentes): a mesma conta z.ai pode
  // chegar por N credenciais (subprocesso no /proc, OpenCode auth.json, terminal)
  // com ids/sufixos distintos, mas as linhas são IDÊNTICAS (mesmo agente, mesma
  // janela, mesmo reset). Colapsa por chave semântica — fica com a de valor bom
  // e fetchedAt mais recente. Resolve o "GLM aparecendo muitas vezes".
  const byContent = new Map();
  for (const e of deduped) {
    if (!e) continue;
    // Normaliza o rótulo de provedor do GLM (" (z.ai)"/" (bigmodel.cn)") antes de
    // gerar a chave: a MESMA conta pode chegar canônica (1 conta → plan 'GLM Pro',
    // id 'glm-month') ou sufixada (multi-conta → plan 'GLM Pro (z.ai)', id
    // 'glm-month:hash') conforme o número de contas oscila entre ticks, ou ficar
    // como resquício legado no usage.json. Sem isto as duas versões têm chaves
    // diferentes e não colapsam → o GLM aparece duplicado ("z.ai 2×").
    const planNorm = String(e.plan || '').replace(/\s*\((z\.ai|bigmodel\.cn)\)\s*$/, '').trim();
    // Normaliza o resetAt p/ SEGUNDOS na chave: a mesma conta chegando por 2
    // credenciais (tokens distintos) recebe resetAt da API com diferença de ~1ms
    // ("...09.995Z" vs "...09.996Z") — sem isto, a chave difere e o tile mensal
    // aparece duplicado ("z.ai Pro mês 2×"). Trunca sub-segundo; contas realmente
    // distintas têm resets separados por muito mais que 1s.
    const resetMs = e.resetAt ? Date.parse(e.resetAt) : NaN;
    const resetKey = Number.isNaN(resetMs) ? '' : Math.floor(resetMs / 1000);
    const key = [e.agent, e.title || '', planNorm, resetKey].join('|');
    const prev = byContent.get(key);
    if (!prev) { byContent.set(key, e); continue; }
    // escolhe a melhor: valor bom > stale menor > fetchedAt maior.
    const better = (isGood(e) && !isGood(prev)) ? e
      : (isGood(prev) && !isGood(e)) ? prev
      : ((e.fetchedAt || 0) >= (prev.fetchedAt || 0) ? e : prev);
    byContent.set(key, better);
  }
  return [...byContent.values()];
}

// Parseia o conteúdo de /proc/<pid>/environ (pares KEY=val separados por NUL)
// e devolve só as chaves pedidas. Puro (testável) — o I/O de ler o arquivo fica
// no main.js. Usado pra extrair ANTHROPIC_BASE_URL/AUTH_TOKEN do terminal GLM.
function parseEnviron(raw, keys) {
  const want = new Set(keys || []);
  const out = {};
  if (typeof raw !== 'string') return out;
  for (const kv of raw.split('\0')) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const k = kv.slice(0, i);
    if (want.has(k)) out[k] = kv.slice(i + 1);
  }
  return out;
}

// ======================= detectReset (aviso de "cota resetou") =======================
// Decide QUANDO avisar que um limite que estava ESGOTADO acabou de resetar (a
// cota liberou de novo). Reconcilia por TRANSIÇÃO de estado entre coletas — não
// agenda timer no resetAt — então sobrevive a app dormir/hibernar e coletas
// perdidas: o loop de 60s do main.js compara o antes/depois a cada tick.
//
// FUNÇÃO PURA: não usa Date.now() nem dispara Notification. O main.js injeta o
// relógio (`now`) e faz o efeito colateral. Testável com `now` fixo — os casos
// em test/usage.test.js são a especificação.
//
// Parâmetros:
//   prevState — estado da chamada anterior por id: { [id]: { resetAtMs, armed } }
//               (ou null/undefined na 1ª coleta).
//   entries   — entradas atuais de uso: [{ id, usedPct, resetAt, plan, title, ... }].
//   now       — epoch em ms (injetado).
//   threshold — % de uso que "arma" o aviso (0–100). armado = usedPct >= threshold.
// Retorna:
//   { toNotify, nextState } — toNotify = entradas que resetaram estando armadas;
//                             nextState = estado a passar para a próxima chamada.
function detectReset(prevState, entries, now, threshold) {
  const prev = prevState || {};
  const nextState = {};
  const toNotify = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.id || nextState[e.id]) continue;       // sem id, ou id já visto neste tick → dedupe
    if (!e.resetAt) continue;                            // sem horário de reset → não dá pra detectar
    const resetAtMs = Date.parse(e.resetAt);
    if (Number.isNaN(resetAtMs)) continue;             // resetAt malformado → ignora
    const armed = typeof e.usedPct === 'number' && e.usedPct >= threshold;
    const p = prev[e.id];                              // estado anterior deste limite (ou undefined)

    // Resetou estando armado? O relógio passou do resetAt da leitura ANTERIOR E
    // o limite estava esgotado nessa leitura — no instante do reset o % já caiu,
    // então "estava esgotado" só existe em `p`. (Só `now >= p.resetAtMs`: antes
    // havia `|| resetAtMs > p.resetAtMs`, mas era falso positivo quando a API
    // estendia o resetAt antes do tempo sem resetar de verdade.)
    const windowTurned = !!p && now >= p.resetAtMs;
    const resetou = windowTurned && p.armed;
    if (resetou) toNotify.push(e);
    // Re-arma pelo % atual, mas "gruda" o armado enquanto a MESMA janela segue:
    // uma oscilação do % pra baixo antes do reset não pode desarmar o aviso.
    // Numa janela nova (após reset) NÃO regruda → dedupe no tick seguinte.
    const sameWindow = !!p && resetAtMs === p.resetAtMs;
    const staleResetWindow = sameWindow && now >= resetAtMs && !p.armed;
    const nextArmed = resetou || staleResetWindow
      ? false
      : armed || (sameWindow && p.armed);
    nextState[e.id] = { resetAtMs, armed: nextArmed };
  }
  return { toNotify, nextState };
}

if (typeof module !== 'undefined') module.exports = {
  parseClaudeConfig, parseAnthropicUsage, parseGlmQuota, parseCodexRateLimits, parseAntigravityTier, parseAntigravityQuota,
  readClaudeUsage, readGlmUsage, readCodexUsage, readAntigravityUsage, collectUsage, parseEnviron,
  findCodexRollout, lastCodexRateLimits, mergeUsage, isSummaryEntry, detectReset, parseRetryAfter,
  USAGE_STALE_MS, USAGE_DROP_MS, CLAUDE_429_COOLDOWN_MS, CLAUDE_CACHE_MS,
  CLAUDE_429_BACKOFF_FACTOR, CLAUDE_429_MAX_BACKOFF_MS,
  _clearGlmCache, _clearClaudeCache, _clearCodexCache, _httpsGetJson, CLAUDE_TIER_LABEL, CLAUDE_ORG_LABEL,
};
