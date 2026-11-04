// Tests for readGatewayUsage (src/usage.js) — Anthropic-compatible gateway (9router).
// I/O with injected fetcher — no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readGatewayUsage, _clearGatewayCache } = require('../src/usage');

// fixed now = 2026-07-07T12:00:00Z → deterministic resets.
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);

function mockFetcher(body) {
  const calls = [];
  const fn = async (url, headers, timeoutMs) => {
    calls.push({ url, headers, timeoutMs });
    return typeof body === 'string' ? body : JSON.stringify(body);
  };
  fn.calls = calls;
  return fn;
}

test('readGatewayUsage: sem credencial → null (omitido)', async () => {
  _clearGatewayCache();
  assert.equal(await readGatewayUsage({ env: {}, now: NOW, fetcher: mockFetcher({}) }), null);
  assert.equal(await readGatewayUsage({ env: { ANTHROPIC_BASE_URL: 'https://9router.aronpc.dev' }, now: NOW, fetcher: mockFetcher({}) }), null);
});

test('readGatewayUsage: base oficial Anthropic → null (coletor do Claude)', async () => {
  _clearGatewayCache();
  const env = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'x' };
  assert.equal(await readGatewayUsage({ env, now: NOW, fetcher: mockFetcher({}) }), null);
});

test('readGatewayUsage: base z.ai → null (coletor GLM)', async () => {
  _clearGatewayCache();
  const env = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'x' };
  assert.equal(await readGatewayUsage({ env, now: NOW, fetcher: mockFetcher({}) }), null);
});

test('readGatewayUsage: shape 9router (janela única five_hour + plan) → entry com % e reset', async () => {
  _clearGatewayCache();
  const env = { ANTHROPIC_BASE_URL: 'https://9router.aronpc.dev', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const f = mockFetcher({
    five_hour: { utilization: 66, resets_at: '2026-07-07T17:00:00.000Z' },
    seven_day: { utilization: 10, resets_at: '2026-07-14T00:00:00.000Z' },
    extra_usage: null,
    plan: 'Kimi Coding',
  });
  const out = await readGatewayUsage({ env, now: NOW, fetcher: f });
  assert.equal(out.length, 2);
  assert.equal(out[0].agent, 'claude');
  assert.equal(out[0].usedPct, 66);
  assert.equal(out[0].resetAt, '2026-07-07T17:00:00.000Z');
  assert.equal(out[0].resetInMin, 300);
  assert.equal(out[0].plan, 'Kimi Coding');
  assert.equal(out[1].usedPct, 10);
  // endpoint padrão Anthropic na base da sessão, com Bearer
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://9router.aronpc.dev/api/oauth/usage');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok');
});

test('readGatewayUsage: sem plan no payload → label cai no host da base', async () => {
  _clearGatewayCache();
  const env = { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const out = await readGatewayUsage({ env, now: NOW, fetcher: mockFetcher({ five_hour: { utilization: 5, resets_at: null } }) });
  assert.equal(out[0].plan, 'gw.example.com');
});

test('readGatewayUsage: erro de rede → entry com error, não lança', async () => {
  _clearGatewayCache();
  const env = { ANTHROPIC_BASE_URL: 'https://9router.aronpc.dev', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const f = async () => { const e = new Error('boom'); e.statusCode = 500; throw e; };
  const out = await readGatewayUsage({ env, now: NOW, fetcher: f });
  assert.equal(out.length, 1);
  assert.equal(out[0].usedPct, null);
  assert.match(out[0].error, /boom/);
});

test('readGatewayUsage: payload sem janelas → entry "no windows parsed"', async () => {
  _clearGatewayCache();
  const env = { ANTHROPIC_BASE_URL: 'https://9router.aronpc.dev', ANTHROPIC_AUTH_TOKEN: 'tok' };
  const out = await readGatewayUsage({ env, now: NOW, fetcher: mockFetcher({}) });
  assert.equal(out.length, 1);
  assert.equal(out[0].usedPct, null);
  assert.match(out[0].error, /no windows/);
});
