// Testes dos coletores de consumo/reset (src/usage.js).
// Lógica PURA (parse) sobre fixtures + I/O com fetcher/home injetados — sem rede.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseClaudeConfig, parseAnthropicUsage, parseGlmQuota, parseCodexRateLimits,
  parseAntigravityTier, parseAntigravityQuota,
  lastCodexRateLimits, readClaudeUsage, readGlmUsage, readCodexUsage, readAntigravityUsage,
  collectUsage, parseEnviron, mergeUsage, detectReset, parseRetryAfter,
  _clearGlmCache, _clearClaudeCache, _clearCodexCache,
} = require('../src/usage');

// now fixo = 2026-07-07T12:00:00Z → testes determinísticos (mês é 0-indexed em JS: 6=Jul).
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);

// =========================== parseEnviron (/proc/<pid>/environ) ===========================

test('parseEnviron: extrai só as chaves pedidas de pares KEY=val\\0', () => {
  const raw = 'PATH=/usr/bin\0ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic\0ANTHROPIC_AUTH_TOKEN=sk-abc\0HOME=/home/x\0';
  const env = parseEnviron(raw, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-abc');
  assert.equal(env.PATH, undefined);       // não pedida → ignorada
});

test('parseEnviron: valor com "=" interno preservado; entradas malformadas ignoradas', () => {
  const raw = 'ANTHROPIC_AUTH_TOKEN=a=b=c\0=semkey\0soletra\0';
  const env = parseEnviron(raw, ['ANTHROPIC_AUTH_TOKEN']);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'a=b=c'); // só o 1º "=" separa
  assert.deepEqual(Object.keys(env), ['ANTHROPIC_AUTH_TOKEN']);
});

test('parseEnviron: entrada não-string ou chave ausente → {}', () => {
  assert.deepEqual(parseEnviron(null, ['X']), {});
  assert.deepEqual(parseEnviron('FOO=bar\0', ['ANTHROPIC_BASE_URL']), {});
});

// =========================== parseClaudeConfig ===========================

test('parseClaudeConfig: extrai reset + plano + passes', () => {
  const cfg = {
    cachedGrowthBookFeatures: { tengu_saffron_lattice: { planLimitsEndDate: '2026-07-08T07:00:00Z' } },
    oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' },
    passesLastSeenRemaining: 3,
  };
  const r = parseClaudeConfig(cfg, NOW);
  assert.equal(r.resetAt, '2026-07-08T07:00:00Z');
  assert.equal(r.plan, 'Claude Max 5×');
  assert.equal(r.passes, 3);
  assert.equal(r.usedPct, null);            // % nunca vem do arquivo (honesto)
  // 2026-07-08T07:00Z - 2026-07-07T12:00Z = 19h = 1140min
  assert.equal(r.resetInMin, 1140);
});

test('parseClaudeConfig: tier 20x e sem passes', () => {
  const cfg = {
    oauthAccount: { organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
  };
  assert.equal(parseClaudeConfig(cfg, NOW).plan, 'Claude Max 20×');
  assert.equal(parseClaudeConfig(cfg, NOW).passes, null);
  assert.equal(parseClaudeConfig(cfg, NOW).resetAt, null);
});

test('parseClaudeConfig: só organizationType (sem tier) → "Claude Max"', () => {
  const cfg = { oauthAccount: { organizationType: 'claude_max' } };
  assert.equal(parseClaudeConfig(cfg, NOW).plan, 'Claude Max');
});

test('parseClaudeConfig: organizationType claude_team → "Claude Team"', () => {
  const cfg = { oauthAccount: { organizationType: 'claude_team' } };
  assert.equal(parseClaudeConfig(cfg, NOW).plan, 'Claude Team');
});

test('parseClaudeConfig: tier desconhecido (default_raven) mas org presente → "Claude" genérico (não some)', () => {
  // Regressão do "créditos do Claude sumiram": conta virou team/tier opaco que
  // não mapeamos → antes plan ficava null e o tile desaparecia. Agora: rótulo
  // genérico enquanto houver QUALQUER campo de identidade da conta.
  const cfg = { oauthAccount: { organizationType: 'unknown_kind', organizationRateLimitTier: 'default_raven', emailAddress: 'x@y.com' } };
  assert.equal(parseClaudeConfig(cfg, NOW).plan, 'Claude');
});

test('parseClaudeConfig: sem oauthAccount → plan null (sem conta, some do overlay)', () => {
  assert.equal(parseClaudeConfig({ cachedGrowthBookFeatures: {} }, NOW).plan, null);
});

test('parseClaudeConfig: payload vazio/malformado → tudo null', () => {
  const r = parseClaudeConfig({}, NOW);
  assert.deepEqual(r, { usedPct: null, resetAt: null, resetInMin: null, plan: null, passes: null });
  assert.deepEqual(parseClaudeConfig(null, NOW).plan, null);
});

test('parseClaudeConfig: reset no passado → resetInMin 0 (não negativo)', () => {
  const cfg = { cachedGrowthBookFeatures: { tengu_saffron_lattice: { planLimitsEndDate: '2026-07-01T00:00:00Z' } } };
  assert.equal(parseClaudeConfig(cfg, NOW).resetInMin, 0);
});

// =========================== parseGlmQuota ===========================

test('parseGlmQuota: TOKENS_LIMIT (5h) + TIME_LIMIT (mês)', () => {
  const payload = {
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 23 },
      { type: 'TIME_LIMIT', percentage: 45, currentValue: 1200000, usage: 2500000 },
    ],
  };
  const out = parseGlmQuota(payload, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Tokens (5h)');
  assert.equal(out[0].usedPct, 23);
  assert.equal(out[1].title, 'MCP (mês)');
  assert.equal(out[1].usedPct, 45);
  assert.equal(out[1].extra, '1.2M/2.5M');
});

test('parseGlmQuota: schema real (data.limits + nextResetTime em ms + level)', () => {
  // payload cru do /api/monitor/usage/quota/limit (z.ai), capturado em 2026-07-07.
  const payload = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
      level: 'pro',
      limits: [
        { type: 'TIME_LIMIT', usage: 1000, currentValue: 1001, remaining: 0, percentage: 100,
          nextResetTime: Date.UTC(2026, 6, 9, 12, 0, 0),  // 2 dias depois de NOW
          usageDetails: [{ modelCode: 'search-prime', usage: 856 }] },
        { type: 'TOKENS_LIMIT', percentage: 71, nextResetTime: Date.UTC(2026, 6, 7, 17, 0, 0) }, // 5h depois
      ],
    },
  };
  const out = parseGlmQuota(payload, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'MCP (mês)');
  assert.equal(out[0].usedPct, 100);
  assert.equal(out[0].level, 'pro');
  assert.equal(out[0].resetAt, new Date(Date.UTC(2026, 6, 9, 12, 0, 0)).toISOString());
  assert.equal(out[0].resetInMin, 2 * 24 * 60);   // 2 dias = 2880 min
  assert.equal(out[1].title, 'Tokens (5h)');
  assert.equal(out[1].usedPct, 71);
  assert.equal(out[1].resetInMin, 5 * 60);         // 5h = 300 min
});

test('parseGlmQuota: percentage > 100 é clampado', () => {
  const out = parseGlmQuota({ limits: [{ type: 'TOKENS_LIMIT', percentage: 150 }] }, NOW);
  assert.equal(out[0].usedPct, 100);
});

test('parseGlmQuota: payload sem limits → []', () => {
  assert.deepEqual(parseGlmQuota({}, NOW), []);
  assert.deepEqual(parseGlmQuota(null, NOW), []);
  assert.deepEqual(parseGlmQuota({ limits: 'nope' }, NOW), []);
});

test('parseGlmQuota: tipo desconhecido é ignorado', () => {
  const out = parseGlmQuota({ limits: [{ type: 'WEIRD', percentage: 10 }, { type: 'TIME_LIMIT', percentage: 5 }] }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'MCP (mês)');
});

// =========================== parseAnthropicUsage ===========================

test('parseAnthropicUsage: extrai janelas 5h e 7d com utilization + resets_at', () => {
  const payload = {
    five_hour: { utilization: 23, resets_at: '2026-07-07T17:00:00Z' }, // 5h após NOW
    seven_day: { utilization: 78, resets_at: '2026-07-09T12:00:00Z' },
    seven_day_opus: null,
  };
  const out = parseAnthropicUsage(payload, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '5 h');
  assert.equal(out[0].usedPct, 23);
  assert.equal(out[0].resetInMin, 5 * 60);
  assert.equal(out[1].title, '7 dias');
  assert.equal(out[1].usedPct, 78);
});

test('parseAnthropicUsage: janela ausente/sem utilization é pulada; clampa >100', () => {
  const out = parseAnthropicUsage({ five_hour: { utilization: 150 }, seven_day: null }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].usedPct, 100);
  assert.equal(out[0].resetAt, null);
  assert.deepEqual(parseAnthropicUsage(null, NOW), []);
  assert.deepEqual(parseAnthropicUsage({}, NOW), []);
});

// =========================== parseRetryAfter (backoff do 429) ===========================

test('parseRetryAfter: delta-seconds ("1007") → ms', () => {
  assert.equal(parseRetryAfter('1007', NOW), 1007 * 1000);
  assert.equal(parseRetryAfter('0', NOW), 0);
});

test('parseRetryAfter: HTTP-date → ms até a data (nunca negativo)', () => {
  const future = new Date(NOW + 5 * 60_000).toUTCString();
  assert.equal(parseRetryAfter(future, NOW), 5 * 60_000);
  const past = new Date(NOW - 60_000).toUTCString();
  assert.equal(parseRetryAfter(past, NOW), 0);       // passado → 0, não negativo
});

test('parseRetryAfter: ausente/ilegível → null', () => {
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter(undefined, NOW), null);
  assert.equal(parseRetryAfter('lixo', NOW), null);
});

// =========================== readClaudeUsage (I/O + OAuth) ===========================

// Monta um home tmp com .claude.json (plano) e opcionalmente .credentials.json (OAuth).
function claudeHome({ plan = true, token = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-'));
  if (plan) {
    fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({
      oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' },
    }));
  }
  if (token) {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  }
  return tmp;
}

test('readClaudeUsage: OAuth ok → 2 linhas (5h + 7d) com % e reset reais', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'oauth-tok' });
  const f = mockFetcher({ five_hour: { utilization: 23, resets_at: '2026-07-07T17:00:00Z' }, seven_day: { utilization: 78, resets_at: '2026-07-09T12:00:00Z' } });
  const r = await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 'claude-5h');
  assert.equal(r[0].plan, 'Claude Max 5×');
  assert.equal(r[0].usedPct, 23);
  assert.equal(r[0].source, 'anthropic.oauth');
  assert.equal(r[1].id, 'claude-7d');
  assert.equal(r[1].usedPct, 78);
  // header OAuth correto
  assert.equal(f.calls[0].headers.Authorization, 'Bearer oauth-tok');
  assert.equal(f.calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: sem token OAuth → fallback plano-só (1 linha, sem %)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: null });
  const r = await readClaudeUsage({ home: tmp, now: NOW });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'claude-plan');
  assert.equal(r[0].plan, 'Claude Max 5×');
  assert.equal(r[0].usedPct, null);
  assert.equal(r[0].source, 'claude.json');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: plano-só mostra o RESET do plano (planLimitsEndDate) — bug do "reset vazio"', async () => {
  _clearClaudeCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-'));
  fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationType: 'claude_team', organizationRateLimitTier: 'default_raven' },
    cachedGrowthBookFeatures: { tengu_saffron_lattice: { planLimitsEndDate: '2026-07-07T17:00:00Z' } }, // 5h após NOW
  }));
  const r = await readClaudeUsage({ home: tmp, now: NOW });   // sem token → plano-só
  assert.equal(r[0].id, 'claude-plan');
  assert.equal(r[0].plan, 'Claude Team');
  assert.equal(r[0].resetAt, '2026-07-07T17:00:00Z', 'reset do plano preenchido (antes era null)');
  assert.equal(r[0].resetInMin, 5 * 60, 'resetInMin calculado');
  assert.equal(r[0].usedPct, null);                           // % só vem da API (honesto)
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: OAuth falha (rede) → fallback plano-só, não lança', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = async () => { throw new Error('HTTP 401'); };
  const r = await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'claude-plan');
  assert.equal(r[0].usedPct, null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: sem plano nem token → null', async () => {
  _clearClaudeCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-')); // vazio
  assert.equal(await readClaudeUsage({ home: tmp, now: NOW }), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// fetcher que sempre lança 429 (com Retry-After em ms), contando chamadas.
function fetcher429(retryAfterMs) {
  const calls = [];
  const fn = async (url, headers) => {
    calls.push({ url, headers });
    const e = new Error('HTTP 429');
    e.statusCode = 429;
    if (retryAfterMs != null) e.retryAfterMs = retryAfterMs;
    throw e;
  };
  fn.calls = calls;
  return fn;
}

test('readClaudeUsage: 429 → cooldown NÃO rebate na API durante o Retry-After (bug do "Claude sumiu")', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = fetcher429(20 * 60_000);                 // Retry-After 20 min
  // 1ª coleta leva 429 → cai no plano-só e agenda o cooldown.
  const r1 = await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].id, 'claude-plan');             // tile NÃO some
  assert.equal(f.calls.length, 1);
  // +60s: passou do cache (30s) MAS ainda no cooldown → não bate na API de novo.
  const r2 = await readClaudeUsage({ home: tmp, now: NOW + 60_000, fetcher: f });
  assert.equal(r2[0].id, 'claude-plan');
  assert.equal(f.calls.length, 1, 'não deve rebater na API durante o cooldown do 429');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: 429 sem Retry-After usa cooldown padrão (15 min)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = fetcher429(null);                        // sem header legível
  await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  // +10min < 15min padrão → ainda em cooldown, sem nova chamada.
  await readClaudeUsage({ home: tmp, now: NOW + 10 * 60_000, fetcher: f });
  assert.equal(f.calls.length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: 429 mantém o ÚLTIMO valor bom (não regride pro plano-só)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  // 1ª: OK → 2 janelas reais. 2ª: 429 → deve segurar as janelas boas, não sumir %.
  let n = 0;
  const f = async () => {
    n += 1;
    if (n === 1) return JSON.stringify({ five_hour: { utilization: 42, resets_at: '2026-07-07T17:00:00Z' }, seven_day: { utilization: 80, resets_at: '2026-07-09T12:00:00Z' } });
    const e = new Error('HTTP 429'); e.statusCode = 429; e.retryAfterMs = 20 * 60_000; throw e;
  };
  const r1 = await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  assert.equal(r1.length, 2);
  assert.equal(r1[0].usedPct, 42);
  // +60s: cache expirou → tenta, leva 429 → mantém as 2 janelas boas anteriores.
  const r2 = await readClaudeUsage({ home: tmp, now: NOW + 60_000, fetcher: f });
  assert.equal(r2.length, 2, 'segura as janelas boas em vez de cair pro plano-só');
  assert.equal(r2[0].usedPct, 42);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: cache próprio de 5min (não rebate em +60s, ao contrário do GLM 30s)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = mockFetcher({ five_hour: { utilization: 30, resets_at: '2026-07-07T17:00:00Z' } });
  await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  await readClaudeUsage({ home: tmp, now: NOW + 60_000, fetcher: f });   // +60s < 5min
  await readClaudeUsage({ home: tmp, now: NOW + 4 * 60_000, fetcher: f }); // +4min < 5min
  assert.equal(f.calls.length, 1, 'cache de 5min evita rebater a cada tick de 60s');
  // +6min > 5min → cache expira, rebate.
  await readClaudeUsage({ home: tmp, now: NOW + 6 * 60_000, fetcher: f });
  assert.equal(f.calls.length, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: cooldownUntil injetado (persistido) bloqueia a chamada mesmo com cache vazio', async () => {
  _clearClaudeCache();                                 // simula processo recém-iniciado (bun start)
  const tmp = claudeHome({ token: 'tok' });
  const f = fetcher429(20 * 60_000);
  // cooldown veio do disco (futuro) → NÃO deve bater na API no boot (anti-reescalada).
  const r = await readClaudeUsage({ home: tmp, now: NOW, fetcher: f, cooldownUntil: NOW + 10 * 60_000 });
  assert.equal(f.calls.length, 0, 'cooldown persistido evita re-bater no boot e re-escalar o 429');
  assert.equal(r[0].id, 'claude-plan');                // cai no plano-só (cache vazio)
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: 429 chama setCooldown com {until, fails} p/ persistir', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = fetcher429(20 * 60_000);
  let saved = null;
  await readClaudeUsage({ home: tmp, now: NOW, fetcher: f, setCooldown: (o) => { saved = o; } });
  assert.deepEqual(saved, { until: NOW + 20 * 60_000, fails: 1 }, 'persistiu {until=Retry-After, fails=1}');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: 429 seguidos aplicam backoff exponencial (Retry-After × 1.5^fails)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = fetcher429(10 * 60_000);                 // Retry-After fixo 10min
  let saved = null;
  // 1ª falha: fails 0→1, backoff = 10min × 1.5^0 = 10min
  await readClaudeUsage({ home: tmp, now: NOW, fetcher: f, setCooldown: (o) => { saved = o; } });
  assert.equal(saved.until, NOW + 10 * 60_000, '1ª falha: sem multiplicar ainda');
  assert.equal(saved.fails, 1);
  // 2ª falha (fails=1 injetado do disco): backoff = 10min × 1.5^1 = 15min
  await readClaudeUsage({ home: tmp, now: NOW + 11 * 60_000, fetcher: f, cooldownFails: 1, setCooldown: (o) => { saved = o; } });
  assert.equal(saved.until, NOW + 11 * 60_000 + 15 * 60_000, '2ª falha: ×1.5 = 15min');
  assert.equal(saved.fails, 2);
  // 3ª falha (fails=2): backoff = 10min × 1.5^2 = 22.5min
  await readClaudeUsage({ home: tmp, now: NOW + 30 * 60_000, fetcher: f, cooldownFails: 2, setCooldown: (o) => { saved = o; } });
  assert.equal(saved.until, NOW + 30 * 60_000 + Math.round(10 * 60_000 * 1.5 * 1.5), '3ª falha: ×2.25');
  assert.equal(saved.fails, 3);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: 429 respeita o teto de backoff (1h)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  const f = fetcher429(30 * 60_000);                 // Retry-After 30min
  let saved = null;
  // fails=10 injetado: 30min × 1.5^10 = imenso → clampado no teto de 1h
  await readClaudeUsage({ home: tmp, now: NOW, fetcher: f, cooldownFails: 10, setCooldown: (o) => { saved = o; } });
  assert.equal(saved.until, NOW + 60 * 60_000, 'clampado no teto de 1h');
  assert.equal(saved.fails, 11);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: sucesso zera o contador de backoff (fails=0)', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  let n = 0;
  const f = async () => {
    n += 1;
    if (n === 1) { const e = new Error('HTTP 429'); e.statusCode = 429; e.retryAfterMs = 5 * 60_000; throw e; }
    return JSON.stringify({ five_hour: { utilization: 9, resets_at: '2026-07-07T17:00:00Z' } });
  };
  let saved = null;
  await readClaudeUsage({ home: tmp, now: NOW, fetcher: f, cooldownFails: 0, setCooldown: (o) => { saved = o; } });
  assert.equal(saved.fails, 1, 'falhou → armou fails=1');
  // depois de expirar, sucesso → zera
  await readClaudeUsage({ home: tmp, now: NOW + 6 * 60_000, fetcher: f, cooldownFails: 1, setCooldown: (o) => { saved = o; } });
  assert.deepEqual(saved, { until: 0, fails: 0 }, 'sucesso zera o backoff persistido');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readClaudeUsage: após o cooldown expirar, rebate na API e recupera o %', async () => {
  _clearClaudeCache();
  const tmp = claudeHome({ token: 'tok' });
  let n = 0;
  const f = async () => {
    n += 1;
    if (n === 1) { const e = new Error('HTTP 429'); e.statusCode = 429; e.retryAfterMs = 5 * 60_000; throw e; }
    return JSON.stringify({ five_hour: { utilization: 12, resets_at: '2026-07-07T17:00:00Z' } });
  };
  const r1 = await readClaudeUsage({ home: tmp, now: NOW, fetcher: f });
  assert.equal(r1[0].id, 'claude-plan');             // 429 → plano-só
  // +6min: cooldown (5min) já expirou → bate de novo e pega o % real.
  const r2 = await readClaudeUsage({ home: tmp, now: NOW + 6 * 60_000, fetcher: f });
  assert.equal(r2[0].id, 'claude-5h');
  assert.equal(r2[0].usedPct, 12);
  assert.equal(n, 2, 'rebateu na API após o cooldown');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// =========================== readGlmUsage (I/O + fetcher mock) ===========================

// fetcher mock: devolve o body dado; captura url/headers para asserção.
function mockFetcher(body) {
  const calls = [];
  const fn = async (url, headers, timeoutMs) => {
    calls.push({ url, headers, timeoutMs });
    return typeof body === 'string' ? body : JSON.stringify(body);
  };
  fn.calls = calls;
  return fn;
}

test('readGlmUsage: sem credencial → null (omitido)', async () => {
  _clearGlmCache();
  assert.equal(await readGlmUsage({ env: {}, now: NOW, fetcher: mockFetcher({}) }), null);
  assert.equal(await readGlmUsage({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }, now: NOW, fetcher: mockFetcher({}) }), null);
});

test('readGlmUsage: base não-GLM → null (backend Anthropic direto)', async () => {
  _clearGlmCache();
  const env = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'x' };
  assert.equal(await readGlmUsage({ env, now: NOW, fetcher: mockFetcher({}) }), null);
});

test('readGlmUsage: credencial GLM válida → 2 entries com %', async () => {
  _clearGlmCache();
  const env = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const f = mockFetcher({ limits: [
    { type: 'TOKENS_LIMIT', percentage: 23 },
    { type: 'TIME_LIMIT', percentage: 45, currentValue: 1000, usage: 2000 },
  ] });
  const out = await readGlmUsage({ env, now: NOW, fetcher: f });
  assert.equal(out.length, 2);
  assert.equal(out[0].agent, 'glm');
  assert.equal(out[0].usedPct, 23);
  assert.equal(out[1].usedPct, 45);
  // endpoint correto e auth header (sem "Bearer")
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /api\.z\.ai\/api\/monitor\/usage\/quota\/limit/);
  assert.equal(f.calls[0].headers.Authorization, 'tok');
});

test('readGlmUsage: erro de rede → entry com error, não lança', async () => {
  _clearGlmCache();
  const env = { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const f = async () => { throw new Error('HTTP 503'); };
  const out = await readGlmUsage({ env, now: NOW, fetcher: f });
  assert.equal(out.length, 1);
  assert.equal(out[0].error, 'HTTP 503');
  assert.equal(out[0].usedPct, null);
});

test('readGlmUsage: cache evita segunda chamada dentro de 30s', async () => {
  _clearGlmCache();
  const env = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const f = mockFetcher({ limits: [{ type: 'TOKENS_LIMIT', percentage: 10 }] });
  await readGlmUsage({ env, now: NOW, fetcher: f });
  await readGlmUsage({ env, now: NOW + 10_000, fetcher: f }); // +10s < 30s cache
  assert.equal(f.calls.length, 1, 'segunda chamada deveria vir do cache');
});

// =========================== collectUsage (orquestrador) ===========================

test('collectUsage: junta Claude (plano-só, sem OAuth) + GLM (API)', async () => {
  _clearGlmCache(); _clearClaudeCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-'));
  fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' },
  })); // sem .credentials.json → Claude cai no plano-só (1 linha)
  const env = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const f = mockFetcher({ limits: [{ type: 'TOKENS_LIMIT', percentage: 30 }] });
  const out = await collectUsage({ home: tmp, env, now: NOW, fetcher: f });
  assert.equal(out.length, 2);
  assert.equal(out[0].agent, 'claude');          // Claude primeiro
  assert.equal(out[0].usedPct, null);            // plano-só (sem OAuth) → sem %
  assert.equal(out[1].agent, 'glm');
  assert.equal(out[1].usedPct, 30);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('collectUsage: sem nenhuma fonte → []', async () => {
  _clearGlmCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-')); // sem .claude.json
  const out = await collectUsage({ home: tmp, env: {}, now: NOW });
  assert.deepEqual(out, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// fetcher ciente do token: % diferente por conta (prova isolamento multi-conta)
function tokenFetcher(pctByToken) {
  const calls = [];
  const fn = async (url, headers) => {
    const tok = headers.Authorization;
    calls.push(tok);
    const pct = pctByToken[tok] != null ? pctByToken[tok] : 0;
    return JSON.stringify({ code: 200, success: true, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', percentage: pct }] } });
  };
  fn.calls = calls;
  return fn;
}

test('collectUsage: múltiplas contas GLM → um bloco por conta, % isolado', async () => {
  _clearGlmCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-')); // sem Claude
  const glmCreds = [
    { env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tokA' }, label: 'z.ai', suffix: 'aaa' },
    { env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tokB' }, label: 'bigmodel.cn', suffix: 'bbb' },
  ];
  const f = tokenFetcher({ tokA: 20, tokB: 75 });
  const out = await collectUsage({ home: tmp, glmCreds, now: NOW, fetcher: f });
  assert.equal(out.length, 2, 'uma linha por conta');
  assert.equal(out[0].id, 'glm-tokens:aaa');
  assert.equal(out[0].usedPct, 20);
  assert.equal(out[0].plan, 'GLM Pro (z.ai)');       // rótulo distingue a conta
  assert.equal(out[1].id, 'glm-tokens:bbb');
  assert.equal(out[1].usedPct, 75);
  assert.equal(out[1].plan, 'GLM Pro (bigmodel.cn)');
  assert.equal(f.calls.length, 2, 'uma chamada por conta distinta');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('collectUsage: conta única não rotula nem sufixa (id canônico)', async () => {
  _clearGlmCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-'));
  const glmCreds = [{ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' }, label: 'z.ai', suffix: 'xyz' }];
  const f = tokenFetcher({ tok: 40 });
  const out = await collectUsage({ home: tmp, glmCreds, now: NOW, fetcher: f });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'glm-tokens');             // sem sufixo (1 conta só)
  assert.equal(out[0].plan, 'GLM Pro');              // sem rótulo
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('readGlmUsage: cache é POR TOKEN (conta B não usa cache da conta A)', async () => {
  _clearGlmCache();
  const f = tokenFetcher({ tokA: 10, tokB: 90 });
  const a = await readGlmUsage({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tokA' }, now: NOW, fetcher: f });
  const b = await readGlmUsage({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'tokB' }, now: NOW, fetcher: f });
  assert.equal(a[0].usedPct, 10);
  assert.equal(b[0].usedPct, 90);                    // não veio do cache de A
  assert.equal(f.calls.length, 2);
});

// =========================== Codex (rollout) ===========================

test('parseCodexRateLimits: primary(5h) + secondary(7d), resets_at em segundos', () => {
  const rl = {
    primary: { used_percent: 3, window_minutes: 300, resets_at: Math.round(NOW / 1000) + 5 * 3600 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: Math.round(NOW / 1000) + 2 * 86400 },
    plan_type: 'plus',
  };
  const out = parseCodexRateLimits(rl, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '5 h');
  assert.equal(out[0].usedPct, 3);
  assert.equal(out[0].resetInMin, 5 * 60);
  assert.equal(out[1].title, '7 dias');
  assert.equal(out[1].usedPct, 40);
});

test('parseCodexRateLimits: janela ausente pulada; clampa; null → []', () => {
  const out = parseCodexRateLimits({ primary: { used_percent: 150, window_minutes: 300 }, secondary: null }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].usedPct, 100);
  assert.equal(out[0].resetAt, null);
  assert.deepEqual(parseCodexRateLimits(null, NOW), []);
});

test('lastCodexRateLimits: pega o rate_limits do ÚLTIMO token_count (payload.type)', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/x' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10 } } } }),
    JSON.stringify({ type: 'response_item' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 55 } } } }),
  ].join('\n');
  const rl = lastCodexRateLimits(jsonl);
  assert.equal(rl.primary.used_percent, 55);         // o último, não o primeiro
  assert.equal(lastCodexRateLimits('lixo\n{}'), null);
});

test('readCodexUsage: acha rollout por cwd, extrai 2 linhas (IO injetado)', () => {
  _clearCodexCache();
  const meta = JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/x/proj' } });
  const tok = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 7, window_minutes: 300, resets_at: Math.round(NOW / 1000) + 3600 },
    secondary: { used_percent: 22, window_minutes: 10080, resets_at: Math.round(NOW / 1000) + 86400 },
    plan_type: 'pro',
  } } });
  const io = {
    listFiles: () => ['/roll/a.jsonl'],
    statMtime: () => 100,
    readHead: () => meta,
    readFull: () => meta + '\n' + tok,
  };
  const r = readCodexUsage({ cwd: '/home/x/proj', now: NOW, ...io });
  assert.equal(r.length, 2);
  assert.equal(r[0].agent, 'codex');
  assert.equal(r[0].plan, 'Codex Pro');
  assert.equal(r[0].usedPct, 7);
  assert.equal(r[0].id, 'codex-5h');
  assert.equal(r[0].source, 'codex.rollout');
});

test('readCodexUsage: cwd sem rollout casando → null', () => {
  _clearCodexCache();
  const io = { listFiles: () => ['/roll/a.jsonl'], statMtime: () => 1, readHead: () => JSON.stringify({ payload: { cwd: '/outro' } }), readFull: () => '' };
  assert.equal(readCodexUsage({ cwd: '/home/x/proj', now: NOW, ...io }), null);
});

// =========================== mergeUsage (anti-zeragem) ===========================

const GOOD = (id, pct) => ({ id, agent: 'glm', plan: 'GLM Pro', title: 'Tokens', usedPct: pct, resetInMin: 40, source: 'glm.api', error: null });
const BAD = (id) => ({ id, agent: 'glm', plan: 'GLM', title: 'GLM', usedPct: null, source: 'glm.api', error: 'HTTP 503' });

test('mergeUsage: coleta ruim mantém o último valor bom (não zera)', () => {
  const t1 = mergeUsage([], [GOOD('glm-tokens', 75)], NOW);
  assert.equal(t1[0].usedPct, 75);
  assert.equal(t1[0].stale, false);
  // +30s, coletor falhou → mantém 75, ainda não stale
  const t2 = mergeUsage(t1, [BAD('glm-tokens')], NOW + 30_000);
  assert.equal(t2[0].usedPct, 75);
  assert.equal(t2[0].stale, false);
});

test('mergeUsage: após STALE_MS sem valor bom → stale (cinza)', () => {
  const t1 = mergeUsage([], [GOOD('glm-tokens', 75)], NOW);
  const t2 = mergeUsage(t1, [BAD('glm-tokens')], NOW + 5 * 60_000);
  assert.equal(t2[0].usedPct, 75);
  assert.equal(t2[0].stale, true);
  // valor bom novo zera o relógio
  const t3 = mergeUsage(t2, [GOOD('glm-tokens', 60)], NOW + 6 * 60_000);
  assert.equal(t3[0].usedPct, 60);
  assert.equal(t3[0].stale, false);
});

test('mergeUsage: linha some da coleta → mantém até DROP_MS, depois remove', () => {
  const t1 = mergeUsage([], [GOOD('glm-tokens', 75)], NOW);
  const t2 = mergeUsage(t1, [], NOW + 5 * 60_000);   // sumiu, +5min
  assert.equal(t2.length, 1);
  assert.equal(t2[0].stale, true);                    // segurou, mas cinza
  const t3 = mergeUsage(t2, [], NOW + 25 * 60_000);  // +25min → dropa
  assert.equal(t3.length, 0);
});

test('mergeUsage: linha nova sem valor bom passa como veio (1ª aparição honesta)', () => {
  const m = mergeUsage([], [BAD('codex-5h')], NOW);
  assert.equal(m.length, 1);
  assert.equal(m[0].usedPct, null);
  assert.equal(m[0].stale, false);
});

// =========================== mergeUsage: dedup summary↔concrete ===========================
// Bug do overlay "duplicando às vezes": a coleta oscila entre OK (tiles reais)
// e falha (fallback plano-só / GLM-sem-limites) entre ticks. Sem desduplicação,
// o fallback coexistia com os reais — "Claude Max" + "Claude Max 5× - 5 h" na
// mesma tela. O summary só deve aparecer se NÃO houver tile concreto do mesmo
// agente.
const CLAUDE_5H = { id: 'claude-5h', agent: 'claude', plan: 'Claude Max 5×', title: '5 h', usedPct: 63, resetInMin: 200, source: 'anthropic.oauth', error: null };
const CLAUDE_PLAN = { id: 'claude-plan', agent: 'claude', plan: 'Claude Max 5×', title: null, usedPct: null, resetInMin: null, source: 'claude.json', error: null };
const GLM_FALLBACK = { id: 'glm', agent: 'glm', plan: 'GLM', title: 'GLM', usedPct: null, resetInMin: null, source: 'glm.api', error: 'timeout' };

test('mergeUsage: claude-plan suprimido quando claude-5h (concreto) está presente', () => {
  // tick OK → 5h real
  const t1 = mergeUsage([], [CLAUDE_5H], NOW);
  assert.equal(t1.length, 1);
  // tick seguinte: API OAuth oscilou → só veio o plano-só (fallback). O 5h vira
  // órfão bom; o plano NÃO deve reaparecer junto dele.
  const t2 = mergeUsage(t1, [CLAUDE_PLAN], NOW + 30_000);
  assert.equal(t2.length, 1, 'plano-só não coexiste com o 5h real');
  assert.equal(t2[0].id, 'claude-5h');
});

test('mergeUsage: fallback GLM suprimido quando glm-month/glm-tokens estão presentes', () => {
  const t1 = mergeUsage([], [GOOD('glm-month', 100)], NOW);
  const t2 = mergeUsage(t1, [GLM_FALLBACK], NOW + 30_000);
  assert.equal(t2.length, 1, 'fallback GLM não coexiste com os limites reais');
  assert.equal(t2[0].id, 'glm-month');
});

test('mergeUsage: summary sozinho (sem concreto) se mantém (1ª aparição honesta)', () => {
  const m = mergeUsage([], [CLAUDE_PLAN], NOW);
  assert.equal(m.length, 1);
  assert.equal(m[0].id, 'claude-plan');
});

// =========================== readAntigravityUsage ===========================

test('readAntigravityUsage: extrai modelo do settings.json do Antigravity', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tl-test-antigravity-'));
  const configDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'gemini-2.5-pro' }));

  try {
    const r = readAntigravityUsage({ home: tmpHome });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'antigravity-plan');
    assert.equal(r[0].agent, 'antigravity');
    assert.equal(r[0].plan, 'Antigravity (gemini-2.5-pro)');
    assert.equal(r[0].source, 'antigravity.settings');
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
});

test('readAntigravityUsage: sem settings.json → retorna null', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tl-test-antigravity-missing-'));
  try {
    const r = readAntigravityUsage({ home: tmpHome });
    assert.equal(r, null);
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
});


// =========================== Antigravity (settings.json) ===========================

test('parseAntigravityTier: extrai o modelo ativo de settings', () => {
  assert.deepEqual(parseAntigravityTier({ model: 'GPT-OSS 120B (Medium)' }), { model: 'GPT-OSS 120B (Medium)' });
  assert.deepEqual(parseAntigravityTier({ selectedModel: 'gemini-2.5-pro' }), { model: 'gemini-2.5-pro' });
});

test('parseAntigravityTier: sem modelo → {model:null}; não-objeto → null', () => {
  assert.deepEqual(parseAntigravityTier({ colorScheme: 'dark' }), { model: null });
  assert.equal(parseAntigravityTier(null), null);
});

test('readAntigravityUsage: readFile injetado → linha com o modelo (sem %)', () => {
  const r = readAntigravityUsage({ home: '/x', readFile: () => JSON.stringify({ model: 'GPT-OSS 120B (Medium)' }) });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'antigravity-plan');
  assert.equal(r[0].agent, 'antigravity');
  assert.equal(r[0].plan, 'Antigravity (GPT-OSS 120B (Medium))');
  assert.equal(r[0].usedPct, null);           // % inviável
  assert.equal(r[0].source, 'antigravity.settings');
});

test('readAntigravityUsage: settings sem modelo → rótulo "Antigravity" simples', () => {
  const r = readAntigravityUsage({ home: '/x', readFile: () => JSON.stringify({ colorScheme: 'dark' }) });
  assert.equal(r[0].plan, 'Antigravity');
});

test('readAntigravityUsage: readFile lança (sem arquivo) → null', () => {
  const r = readAntigravityUsage({ home: '/x', readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(r, null);
});

// =========================== Antigravity — quota esgotada (DBs de conversa) ===========================

test('parseAntigravityQuota: pega o MAIOR quotaResetTimeStamp futuro', () => {
  const txt = 'lixo\0"reason":"QUOTA_EXHAUSTED",...,"quotaResetTimeStamp":"2026-07-10T00:00:00Z"...'
    + '\0mais\0"reason":"QUOTA_EXHAUSTED","quotaResetTimeStamp":"2026-07-14T19:56:12Z"...';
  const q = parseAntigravityQuota(txt, NOW);
  assert.deepEqual(q, { resetAt: '2026-07-14T19:56:12Z' }); // o mais distante
});

test('parseAntigravityQuota: reset no passado → null (não está esgotada agora)', () => {
  const txt = '"reason":"QUOTA_EXHAUSTED","quotaResetTimeStamp":"2026-07-01T00:00:00Z"';
  assert.equal(parseAntigravityQuota(txt, NOW), null);
  assert.equal(parseAntigravityQuota('sem quota aqui', NOW), null);
  assert.equal(parseAntigravityQuota(null, NOW), null);
});

test('readAntigravityUsage: quota esgotada → usedPct 100 + reset (DB injetado)', () => {
  const r = readAntigravityUsage({
    home: '/x', now: NOW,
    readFile: () => JSON.stringify({ model: 'gpt-oss-120b-medium' }),
    listDbs: () => ['/db/a.db', '/db/b.db'],
    mtime: (f) => (f === '/db/b.db' ? NOW - 5*60*1000 : NOW - 10*60*1000), // b é mais novo, ambos recentes
    readDb: (f) => (f === '/db/b.db'
      ? '"reason":"QUOTA_EXHAUSTED","quotaResetTimeStamp":"2026-07-14T19:56:12Z"'
      : 'sem quota'),
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'antigravity-quota');
  assert.equal(r[0].usedPct, 100);            // esgotado → barra cheia
  assert.equal(r[0].resetAt, '2026-07-14T19:56:12Z');
  assert.equal(r[0].source, 'antigravity.quota');
  assert.equal(r[0].plan, 'Antigravity (gpt-oss-120b-medium)');
});

test('readAntigravityUsage: com quota (nenhum QUOTA_EXHAUSTED futuro) → só rótulo', () => {
  const r = readAntigravityUsage({
    home: '/x', now: NOW,
    readFile: () => JSON.stringify({ model: 'm' }),
    listDbs: () => ['/db/a.db'],
    mtime: () => 1,
    readDb: () => 'conversa normal sem erro de quota',
  });
  assert.equal(r[0].id, 'antigravity-plan');
  assert.equal(r[0].usedPct, null);
});

// =========================== mergeUsage — dedup por conteúdo (mesma conta) ===========================

test('mergeUsage: linhas idênticas com ids diferentes → colapsa em 1 (mesma conta z.ai)', () => {
  // mesma conta chega por 2 credenciais (proc + opencode): ids distintos, resto igual.
  const a = { id: 'glm-tokens:proc', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro (z.ai)', usedPct: 12, resetAt: '2026-07-08T02:00:00Z', error: null };
  const b = { id: 'glm-tokens:oc', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro (z.ai)', usedPct: 12, resetAt: '2026-07-08T02:00:00Z', error: null };
  const out = mergeUsage([], [a, b], NOW);
  assert.equal(out.length, 1, 'colapsou as 2 idênticas em 1');
  assert.equal(out[0].usedPct, 12);
});

test('mergeUsage: conteúdo diferente (reset distinto) → NÃO colapsa (contas reais distintas)', () => {
  const a = { id: 'glm-tokens:x', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro (z.ai)', usedPct: 12, resetAt: '2026-07-08T02:00:00Z', error: null };
  const b = { id: 'glm-tokens:y', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro (bigmodel.cn)', usedPct: 40, resetAt: '2026-07-08T05:00:00Z', error: null };
  const out = mergeUsage([], [a, b], NOW);
  assert.equal(out.length, 2, 'contas com dados diferentes ficam separadas');
});

test('mergeUsage: GLM canônico (plan "GLM Pro") vs sufixado (plan "GLM Pro (z.ai)") da MESMA conta → colapsa (bug z.ai 2×)', () => {
  // Cenário real: a coleta oscila entre single-conta (id canônico 'glm-month',
  // plan 'GLM Pro') e multi-conta (id 'glm-month:6baca3', plan 'GLM Pro (z.ai)'),
  // ou um é resquício legado do usage.json. Sem normalizar o label na chave, as
  // duas linhas têm plans diferentes e coexistem → "z.ai" aparece duplicado.
  const canon = { id: 'glm-month', agent: 'glm', title: 'MCP (mês)', plan: 'GLM Pro', usedPct: 100, resetAt: '2026-08-01T00:00:00Z', fetchedAt: NOW - 2000, error: null };
  const suffixed = { id: 'glm-month:6baca3', agent: 'glm', title: 'MCP (mês)', plan: 'GLM Pro (z.ai)', usedPct: 100, resetAt: '2026-08-01T00:00:00Z', fetchedAt: NOW - 1000, error: null };
  // boot carregou AMBOS do usage.json; sem GLM ativo agora (fresh vazio) → órfãos.
  const out = mergeUsage([canon, suffixed], [], NOW);
  assert.equal(out.length, 1, 'a mesma conta não aparece 2× mesmo com id/plan oscilando');
  assert.equal(out[0].usedPct, 100);
});

test('mergeUsage: GLM tokens 5h canônico vs sufixado → colapsa', () => {
  const canon = { id: 'glm-tokens', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro', usedPct: 46, resetAt: '2026-07-07T17:00:00Z', fetchedAt: NOW - 2000, error: null };
  const suffixed = { id: 'glm-tokens:6baca3', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro (z.ai)', usedPct: 48, resetAt: '2026-07-07T17:00:00Z', fetchedAt: NOW - 1000, error: null };
  const out = mergeUsage([canon, suffixed], [], NOW);
  assert.equal(out.length, 1, 'tokens 5h da mesma conta colapsam em 1 linha');
});

test('mergeUsage: token inválido (summary sem %) some quando há concreto do mesmo agente', () => {
  const bad = { id: 'glm', agent: 'glm', title: 'GLM', plan: 'GLM', usedPct: null, error: 'no limits parsed' };
  const good = { id: 'glm-tokens', agent: 'glm', title: 'Tokens (5h)', plan: 'GLM Pro', usedPct: 7, resetAt: '2026-07-08T02:00:00Z', error: null };
  const out = mergeUsage([], [bad, good], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'glm-tokens'); // o summary fantasma sumiu
});

test('mergeUsage: antigravity-plan limpa antigravity-quota do cache anterior', () => {
  const prev = [{ id: 'antigravity-quota', agent: 'antigravity', plan: 'Antigravity (m)', usedPct: 100, resetAt: '2026-07-14T19:56:12Z', fetchedAt: NOW }];
  const fresh = [{ id: 'antigravity-plan', agent: 'antigravity', plan: 'Antigravity (m)', usedPct: null }];
  const out = mergeUsage(prev, fresh, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'antigravity-plan');
});

// =========================== detectReset (aviso de "cota resetou") ===========================
// PURA: `now` injetado (NOW = 2026-07-07T12:00:00Z, definido no topo). Estes casos
// são a ESPECIFICAÇÃO da regra de transição estava-esgotado → resetou.
const RESET_ENTRY = (id, usedPct, resetAt) => ({ id, agent: 'glm', plan: 'GLM Pro', title: 'Tokens (5h)', usedPct, resetAt });
const H = 3600 * 1000;

test('detectReset: 1ª coleta (sem estado prévio) nunca notifica, só registra', () => {
  const r = detectReset(null, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], NOW, 90);
  assert.equal(r.toNotify.length, 0);
  assert.ok(r.nextState['glm-tokens'], 'registrou o estado do limite p/ o próximo tick');
});

test('detectReset: armado (>= threshold) e o reset chegou → notifica 1x', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  // +6h: passou das 17:00Z; a API avançou a janela (novo reset) e o % caiu.
  const later = NOW + 6 * H;
  const { toNotify } = detectReset(s1, [RESET_ENTRY('glm-tokens', 4, '2026-07-07T22:00:00Z')], later, 90);
  assert.equal(toNotify.length, 1);
  assert.equal(toNotify[0].id, 'glm-tokens');
});

test('detectReset: NÃO estava esgotado (abaixo do threshold) → não notifica no reset', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 40, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  const later = NOW + 6 * H;
  const { toNotify } = detectReset(s1, [RESET_ENTRY('glm-tokens', 2, '2026-07-07T22:00:00Z')], later, 90);
  assert.equal(toNotify.length, 0);
});

test('detectReset: armado mas o reset ainda não chegou → não notifica', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  const soon = NOW + 60 * 1000; // +1min, ainda antes das 17:00Z
  const { toNotify } = detectReset(s1, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], soon, 90);
  assert.equal(toNotify.length, 0);
});

test('detectReset: não redispara no tick seguinte à mesma janela nova (dedupe)', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  const later = NOW + 6 * H;
  const r2 = detectReset(s1, [RESET_ENTRY('glm-tokens', 5, '2026-07-07T22:00:00Z')], later, 90);
  assert.equal(r2.toNotify.length, 1);                 // resetou → avisa
  const r3 = detectReset(r2.nextState, [RESET_ENTRY('glm-tokens', 6, '2026-07-07T22:00:00Z')], later + 60 * 1000, 90);
  assert.equal(r3.toNotify.length, 0, 'mesma janela nova não pode redisparar');
});

test('detectReset: API stale com mesmo resetAt não rearma após notificar', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  const later = NOW + 6 * H;
  const r2 = detectReset(s1, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], later, 90);
  assert.equal(r2.toNotify.length, 1);                 // passou do reset, mas API ainda não avançou
  const r3 = detectReset(r2.nextState, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], later + 60 * 1000, 90);
  assert.equal(r3.toNotify.length, 0, 'mesmo resetAt stale não pode rearma/redisparar');
  assert.equal(r3.nextState['glm-tokens'].armed, false);
});

test('detectReset: entry sem resetAt é ignorada (não quebra, não notifica)', () => {
  const r = detectReset(null, [RESET_ENTRY('claude-plan', null, null)], NOW, 90);
  assert.equal(r.toNotify.length, 0);
  assert.equal(r.nextState['claude-plan'], undefined);
});

test('detectReset: threshold configurável — em 100 só esgotamento total arma (95% não)', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 95, '2026-07-07T17:00:00Z')], NOW, 100).nextState;
  const later = NOW + 6 * H;
  const { toNotify } = detectReset(s1, [RESET_ENTRY('glm-tokens', 5, '2026-07-07T22:00:00Z')], later, 100);
  assert.equal(toNotify.length, 0, '95 < 100 → não armou, logo não notifica');
});

test('detectReset: resetAt estendido ANTES do tempo (sem reset) não notifica', () => {
  // 12:00 esgotado, reset 17:00; às 16:00 (ainda ANTES das 17:00) a API estendeu
  // o resetAt pra 20:00 e o % continua 95 → NÃO houve reset, só mudou o horário.
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 95, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  const before = NOW + 4 * H;
  const { toNotify } = detectReset(s1, [RESET_ENTRY('glm-tokens', 95, '2026-07-07T20:00:00Z')], before, 90);
  assert.equal(toNotify.length, 0, 'extensão de resetAt sem o tempo passar não é reset');
});

test('detectReset: 2 entries mesmo id numa coleta → só 1 notificação', () => {
  const s1 = detectReset(null, [RESET_ENTRY('glm-tokens', 100, '2026-07-07T17:00:00Z')], NOW, 90).nextState;
  const later = NOW + 6 * H;
  const e = RESET_ENTRY('glm-tokens', 4, '2026-07-07T22:00:00Z');
  const { toNotify } = detectReset(s1, [e, e], later, 90);
  assert.equal(toNotify.length, 1, 'duplicata de id não duplica o aviso');
});
