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
  collectUsage, parseEnviron, mergeUsage, _clearGlmCache, _clearClaudeCache, _clearCodexCache,
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

