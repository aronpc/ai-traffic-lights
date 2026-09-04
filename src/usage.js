// usage.js — per-agent USAGE/RESET collectors (feature: % in the overlay).
//
// Two source regimes (see the decision in /docs and in the "caminho C" plan):
//   PASSIVE (local file, no network) — only yields RESET: Claude via ~/.claude.json.
//   ACTIVE  (authenticated call)     — yields % AND reset: GLM via the monitor API.
//
// The PURE logic (parse) is kept separate from the I/O (file read / HTTP) so
// that tests run against fixtures without network or disk. The I/O functions
// NEVER throw: failure becomes { ..., error }. An agent without credentials/config is simply
// omitted from the result — the overlay only shows whoever has data.
//
// Canonical object (one entry per "limit" — an agent may have several):
//   {
//     id:         'glm-tokens' | 'glm-month' | 'claude-plan',
//     agent:      'glm' | 'claude',         // picks icon/color in AGENTS
//     title:      'Tokens (5h)',            // what this limit is (short)
//     usedPct:    23,                        // 0..100, or null if unknown
//     resetAt:    '2026-07-10T19:47:09Z',   // ISO, or null
//     resetInMin: 1234,                      // convenience for the UI, or null
//     extra:      '3 passes',               // optional extra info
//     source:     'claude.json' | 'glm.api',
//     error:      null | '<short msg>',
//   }

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const claudePaths = require('./claude-config.js');

// ---- Claude Max tier → human label translation ----
const CLAUDE_TIER_LABEL = {
  default_claude_max_5x: 'Max 5×',
  default_claude_max_20x: 'Max 20×',
};

// ---- organizationType → human label translation (fallback when the tier is not
// one of the known Max tiers). Covers Team/Pro/Enterprise accounts whose tier has
// an opaque internal code (e.g. default_raven) we don't map individually. ----
const CLAUDE_ORG_LABEL = {
  claude_max: 'Claude Max',
  claude_team: 'Claude Team',
  claude_pro: 'Claude Pro',
  claude_enterprise: 'Claude Enterprise',
};

// =========================== PURE LOGIC (parse) ===========================

// Extracts reset/plan/passes/identity from an already-parsed .claude.json object.
// `now` in ms. Returns {usedPct:null, resetAt, resetInMin, plan, passes,
// accountUuid, accountOrgUuid, accountName, accountEmail}.
// The Claude Max cycle % is NOT persisted on disk (only in the Anthropic API
// runtime) → usedPct is always null here (honest: doesn't invent a number).
// Identity (multi-account, #58): the ORG (accountOrgUuid) is what dedupes when
// it exists — billing and rate limit are per organizationRateLimitTier, and the SAME
// login lives in two Team orgs with independent limits (same accountUuid,
// different organizationUuid → two accounts). A personal account (no org) dedupes
// by accountUuid. organizationName/emailAddress only label — the FULL
// email never shows in the UI (only the local-part, and only in the renderer).
function parseClaudeConfig(cfg, now) {
  const out = { usedPct: null, resetAt: null, resetInMin: null, plan: null, passes: null,
    accountUuid: null, accountOrgUuid: null, accountName: null, accountEmail: null };
  if (!cfg || typeof cfg !== 'object') return out;

  // plan reset: cachedGrowthBookFeatures.tengu_saffron_lattice.planLimitsEndDate
  const saffron = ((cfg.cachedGrowthBookFeatures || {}).tengu_saffron_lattice) || {};
  if (saffron.planLimitsEndDate) out.resetAt = saffron.planLimitsEndDate;

  // plan: oauthAccount.organizationType / organizationRateLimitTier
  // Order: known Max tier (most specific) → known org type → org
  // present but unknown (generic "Claude" label). Only stays null when
  // there is NO OAuth account at all — then the collector omits Claude from the overlay.
  const acc = cfg.oauthAccount || {};
  if (acc.accountUuid && typeof acc.accountUuid === 'string') out.accountUuid = acc.accountUuid;
  if (acc.organizationUuid && typeof acc.organizationUuid === 'string') out.accountOrgUuid = acc.organizationUuid;
  if (acc.organizationName && typeof acc.organizationName === 'string') out.accountName = acc.organizationName;
  if (acc.emailAddress && typeof acc.emailAddress === 'string') out.accountEmail = acc.emailAddress;
  if (acc.organizationRateLimitTier && CLAUDE_TIER_LABEL[acc.organizationRateLimitTier]) {
    out.plan = 'Claude ' + CLAUDE_TIER_LABEL[acc.organizationRateLimitTier];
  } else if (acc.organizationType && CLAUDE_ORG_LABEL[acc.organizationType]) {
    out.plan = CLAUDE_ORG_LABEL[acc.organizationType];
  } else if (acc.organizationType || acc.organizationUuid || acc.emailAddress) {
    // account exists (some identity field), but type/tier unmapped →
    // doesn't vanish from the overlay; shows the generic label.
    out.plan = 'Claude';
  }

  // passes remaining (plan free passes)
  if (typeof cfg.passesLastSeenRemaining === 'number') out.passes = cfg.passesLastSeenRemaining;

  if (out.resetAt) {
    const ms = Date.parse(out.resetAt) - (now || Date.now());
    out.resetInMin = ms > 0 ? Math.round(ms / 60000) : 0;
  }
  return out;
}

// Extracts the limits from a GLM /api/monitor/usage/quota/limit payload.
// Schema (mapped from the official glm-plan-usage plugin):
//   { limits: [
//     { type:'TOKENS_LIMIT', percentage:<N> },                        // 5h
//     { type:'TIME_LIMIT',   percentage:<N>, currentValue, usage }    // monthly
//   ]}
// `now` in ms. Returns an array of canonical entries (without agent/id/source —
// the caller adds the agent context).
//
// Real schema of /api/monitor/usage/quota/limit (z.ai/bigmodel):
//   { code:200, success:true, data: { level:'pro',
//     limits: [
//       { type:'TIME_LIMIT',  percentage:<N>, currentValue, usage, remaining, nextResetTime:<ms>, usageDetails:[...] },
//       { type:'TOKENS_LIMIT', percentage:<N>, nextResetTime:<ms> },
//     ]}}
// `limits` may come at the root (tests) or inside `data` (real API) — both accepted.
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
      let title = 'Tokens (5h)'; // default fallback for old payloads/tests
      if (lim.unit === 6) {
        title = 'Tokens (7d)';
      } else if (lim.unit === 5) {
        title = 'Tokens (mês)';
      }
      out.push({ title: title, usedPct: pct, resetAt, resetInMin, extra: null, level: root.level || null });
    } else if (lim.type === 'TIME_LIMIT') {
      // Monthly MCP/tools (search-prime, web-reader, zread, ...).
      out.push({ title: 'MCP (mês)', usedPct: pct, resetAt, resetInMin, extra: formatUsage(lim.currentValue, lim.usage), level: root.level || null });
    }
  }
  return out;
}

// nextResetTime comes in MILLISECONDS (epoch) in the real schema. Heuristic fallback
// for string fields (resetAt, reset_at, ...) in case the schema changes.
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

// Extracts the usage windows from the api.anthropic.com/api/oauth/usage payload.
// Schema (confirmed in runtime 2026-07-07):
//   { five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at},
//     seven_day_opus:null|{...}, seven_day_sonnet:null|{...}, ... }
// utilization is 0..100 (%). resets_at is ISO. `planLabel` already resolved by the caller.
// Returns [{title, usedPct, resetAt, resetInMin}] — only windows present.
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
  // extra_usage: "extra"/overage usage measured in money (Team/Enterprise with a
  // monthly credit limit, or Pro with overage). used_credits/monthly_limit
  // come in SMALLER UNITS of the currency (decimal_places: USD=2 → cents). Becomes
  // an "Extra" tile with % and the spent/limit value (e.g. "$50.4/$50"). Only included
  // when enabled and with a positive limit — otherwise left out (doesn't clutter the bar).
  const ex = payload.extra_usage;
  if (ex && typeof ex === 'object' && ex.is_enabled && typeof ex.monthly_limit === 'number' && ex.monthly_limit > 0) {
    const dec = (typeof ex.decimal_places === 'number' && ex.decimal_places >= 0 && ex.decimal_places <= 4) ? ex.decimal_places : 2;
    const div = Math.pow(10, dec);
    const spent = typeof ex.used_credits === 'number' ? ex.used_credits / div : null;
    const limit = ex.monthly_limit / div;
    const pct = typeof ex.utilization === 'number' ? clampPct(ex.utilization)
      : (spent != null ? clampPct((spent / limit) * 100) : null);
    const resetAt = typeof ex.resets_at === 'string' ? ex.resets_at : null;
    const resetInMin = resetAt && !Number.isNaN(Date.parse(resetAt))
      ? Math.max(0, Math.round((Date.parse(resetAt) - nowMs) / 60000)) : null;
    const sym = ex.currency === 'USD' || !ex.currency ? '$' : (ex.currency + ' ');
    const extra = spent != null ? `${sym}${spent.toFixed(dec === 0 ? 0 : 1)}/${sym}${limit.toFixed(dec === 0 ? 0 : 1)}` : null;
    out.push({ title: 'Extra', usedPct: pct, resetAt, resetInMin, extra });
  }
  return out;
}

// Extracts the usage windows from the rate_limits of a Codex token_count event.
// Schema (confirmed runtime 2026-07-07, ~/.codex/sessions/**/rollout-*.jsonl):
//   payload.rate_limits: {
//     primary:   { used_percent, window_minutes:300,   resets_at:<epoch s> },  // 5h
//     secondary: { used_percent, window_minutes:10080, resets_at:<epoch s> },  // 7d
//     plan_type: 'plus'|'pro'|...
//   }
// resets_at is epoch in SECONDS (≠ Anthropic ISO, ≠ GLM ms). window_minutes
// names the window (300→"5 h", 10080→"7 dias", other→"Nh"/"Nd"). `now` in ms.
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

// Extracts the usage windows from the OpenCode Go API payload (/zen/go/v1/usage).
// Schema: { usage: { rolling: { percent, resets_at, status }, weekly, monthly } }
// resets_at is an ISO string (same as Anthropic). `now` in ms.
function parseOpencodeUsage(cfg, now) {
  const out = [];
  if (!cfg || typeof cfg !== 'object' || !cfg.usage || typeof cfg.usage !== 'object') return out;
  const usage = cfg.usage;
  const nowMs = now || Date.now();
  for (const key of ['rolling', 'weekly', 'monthly']) {
    const w = usage[key];
    if (!w || typeof w !== 'object' || typeof w.percent !== 'number') continue;
    const resets = w.resetsAt || w.resets_at;
    const resetAt = typeof resets === 'string' && resets ? resets : null;
    let resetInMin = null;
    if (resetAt) {
      const parsed = Date.parse(resetAt);
      if (!Number.isNaN(parsed)) resetInMin = Math.max(0, Math.round((parsed - nowMs) / 60000));
    }
    let title = '?';
    if (key === 'rolling') title = '5h';
    if (key === 'weekly') title = '7d';
    if (key === 'monthly') title = 'Mês';
    out.push({ title, usedPct: clampPct(w.percent), resetAt, resetInMin, status: w.status || null });
  }
  return out;
}

// Names the window by its size in minutes (Codex doesn't label by name).
function windowTitle(min) {
  if (min === 300) return '5 h';
  if (min === 10080) return '7 dias';
  if (typeof min !== 'number' || min <= 0) return 'janela';
  if (min % 1440 === 0) return (min / 1440) + ' dias';
  if (min % 60 === 0) return (min / 60) + ' h';
  return min + ' min';
}

// =========================== I/O ===========================

// Reads the .claude.json and returns the COMPLETE parseClaudeConfig object — plan and
// passes (the plan-only tile uses this when the OAuth API doesn't respond). Cheap,
// synchronous. Returns null when there is NO OAuth account (no .claude.json or no
// identity fields) — distinguishes "no Claude" from "Claude without a mapped plan".
// Note: parsed.resetAt here is the planLimitsEndDate (end of the PLAN cycle), NOT the
// usage window reset — that's why the caller ignores it in the plan-only tile.
//
// Path via claude-config.js: <configdir>/.claude.json (live; configdir may be a
// profile/dd-claude symlink) with legacy fallback ~/.claude.json (frozen).
// Cache keyed by .claude.json mtime (large file, ~170 KB): multi-account reads N
// of these per collection cycle — re-parsing N× on every tick would be wasteful. The
// mtime changes on every Claude Code write, so invalidation is automatic.
// resetInMin depends on `now` → recomputed on every return, without re-parsing.
const _claudeCfgCache = new Map(); // file → { mtime, parsed }
function readClaudeConfig({ home, now, dir } = {}) {
  try {
    for (const f of claudePaths.configCandidates({ home, dir })) {
      let raw, mtime;
      try { raw = fs.readFileSync(f, 'utf8'); mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      let hit = _claudeCfgCache.get(f);
      if (!hit || hit.mtime !== mtime) {
        hit = { mtime, parsed: parseClaudeConfig(JSON.parse(raw), now || Date.now()) };
        _claudeCfgCache.set(f, hit);
      }
      const parsed = hit.parsed;
      // resetInMin is derived from the current time — always fresh, even cached:
      if (parsed.resetAt) {
        const ms = Date.parse(parsed.resetAt) - (now || Date.now());
        parsed.resetInMin = ms > 0 ? Math.round(ms / 60000) : 0;
      }
      // Readable → it IS the source, with or without an account: a new dir without OAuth CANNOT
      // fall through to the frozen legacy (another login's account) — that would be the #58
      // bug again, inverted. No plan → no account, end.
      return parsed.plan ? parsed : null;
    }
    return null;
  } catch { return null; }
}

// Reads the Claude Code OAuth access token from ~/.claude/.credentials.json
// (claudeAiOauth.accessToken). It's the same token Claude Code itself uses;
// we never write or renew it — if it's expired, the API rejects it and we fall back to the
// plan-only fallback (Claude Code renews it on its own during normal use). Never throws.
function readClaudeOAuthToken({ home } = {}) {
  return readClaudeCreds({ home }).accessToken;
}

// Reads the OAuth credentials: accessToken + subscriptionType + rateLimitTier. These
// last two are the MOST reliable source of the plan (the .claude.json may carry an
// opaque internal tier like 'default_raven', while the credentials carry the
// real tier 'default_claude_max_5x'). Never throws — missing fields become null.
// Path via claude-config.js: <configdir>/.credentials.json (configdir may be a
// profile/dd-claude symlink — traversed automatically on access).
function readClaudeCreds({ home, dir } = {}) {
  try {
    const creds = JSON.parse(fs.readFileSync(claudePaths.credsFile({ home, dir }), 'utf8'));
    const o = (creds && creds.claudeAiOauth) || {};
    return {
      accessToken: typeof o.accessToken === 'string' && o.accessToken ? o.accessToken : null,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
      rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : null,
    };
  } catch { return { accessToken: null, subscriptionType: null, rateLimitTier: null }; }
}

// Resolves the plan label from the credentials (trusted source). A known Max
// tier wins; otherwise the subscriptionType (team/pro/enterprise) becomes the label.
// Returns null if the credentials aren't enough (the caller falls back to the .claude.json).
function claudePlanFromCreds({ subscriptionType, rateLimitTier } = {}) {
  if (rateLimitTier && CLAUDE_TIER_LABEL[rateLimitTier]) return 'Claude ' + CLAUDE_TIER_LABEL[rateLimitTier];
  const sub = (subscriptionType || '').toLowerCase();
  const SUB_LABEL = { max: 'Claude Max', team: 'Claude Team', pro: 'Claude Pro', enterprise: 'Claude Enterprise' };
  if (SUB_LABEL[sub]) return SUB_LABEL[sub];
  return null;
}

// Claude collector. Tries the OAuth usage API (REAL % AND reset of the 5h and
// 7d windows — the same data as the dashboard/`/status`); if there's no token or the call
// fails, falls back to: a single plan-only line (no number, honest).
// Cache per token, 30s. Never throws.
//
// 429 (rate limit): the API sends Retry-After (e.g. ~1000s). Hitting it every 60s
// RENEWS the penalty and the % never comes back — that was the "Claude vanished" bug. On a
// 429 we schedule a cooldown (respecting Retry-After) during which we DON'T hit
// the API: we return the last known good value, or plan-only. That way the tile
// doesn't vanish nor flicker ⚠ and the rate limit window expires on its own.
const _claudeCacheByToken = new Map(); // token → { at, entries, cooldownUntil }

// Plan-only tile (without the OAuth API): shows only plan + passes, WITHOUT reset. The
// planLimitsEndDate from .claude.json is the end of the PLAN cycle (e.g. Jul 13),
// NOT the usage window reset (5h/7d, which resets several times until then) — putting it
// here was misleading ("3d" right after the window had reset). The REAL reset of the
// windows only exists in the API runtime (resets_at) → no API, honestly no
// reset. `passes` (plan free passes) is legitimate local info, it stays.
//
// Account WITHOUT oauth and WITHOUT a plan = technical PROXY profile (e.g. gh-claude →
// vm-contabo, which routes GLM): without this the account produced NO bar at all —
// invisible in the usage list. It gets a plan-only "API <host>" tile (the proxy
// doesn't expose Anthropic quota → no %, honest). Only counts NAMED (explicit
// dir): the default is the org symlink, whose settings.json says
// nothing about an alternative API. Profiles without base_url still get no bar.
//
// Returns null when there's no plan nor API to show. Used by
// readClaudeUsage (no token / network failed) AND by collectUsage's catch
// (unexpected reader exception — the tile becomes a live-family signal, see there).
function claudePlanOnlyTile(plan, pc, dir) {
  const api = !plan && dir ? apiProviderFromSettings(dir) : null;
  const planLabel = plan || (api ? 'API ' + api : null);
  if (!planLabel) return null;
  return [{ id: 'claude-plan', agent: 'claude', plan: planLabel, title: null, usedPct: null,
    resetAt: null, resetInMin: null,
    extra: (!api && pc && pc.passes != null ? pc.passes + ' passes' : null),
    source: api ? 'settings.json' : 'claude.json', error: null }];
}

async function readClaudeUsage({ home, dir, now, fetcher, cooldownUntil, cooldownFails, setCooldown, allowFetch = true } = {}) {
  const pc = readClaudeConfig({ home, now, dir });
  const creds = readClaudeCreds({ home, dir });
  // Plan: credentials first (REAL tier/subscription — e.g. 'default_claude_max_5x'),
  // then the .claude.json (which may have only an opaque internal tier). If neither
  // resolves but there's an account, falls back to the .claude.json generic (or null = no account).
  const plan = claudePlanFromCreds(creds) || (pc ? pc.plan : null);
  const token = creds.accessToken;
  const planOnly = claudePlanOnlyTile(plan, pc, dir);
  if (!token) return planOnly;

  const nowMs = now || Date.now();
  const cached = _claudeCacheByToken.get(token);
  if (cached && (nowMs - cached.at) < CLAUDE_CACHE_MS) return cached.entries;
  // PERSISTED cooldown (injected by main.js, survives a restart): without this,
  // `bun start`/dev loses the in-memory cooldown on every restart, hits the API again at boot
  // and RE-ESCALATES the 429 (the server raises Retry-After on every hit). No re-hitting.
  const cd = Math.max(cached && cached.cooldownUntil || 0, cooldownUntil || 0);
  if (cd && nowMs < cd) return (cached && cached.entries) || planOnly;

  // LAZY (on-demand collection): the background loop passes allowFetch=false and does NOT
  // hit the API — the call only happens when the user IS ABOUT TO LOOK at usage (opening/
  // revealing the overlay, ⟳ button) or at boot. /api/oauth/usage shares an AGGREGATED
  // limit with Claude Code's own /status; polling it in a 60s loop fed the
  // 429. Without a trigger, we return the last known good value (or plan-only) —
  // same behavior as the cooldown, but without touching the network.
  if (!allowFetch) return (cached && cached.entries) || planOnly;

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
    // 429 → exponential backoff: each consecutive 429 lengthens the wait (Retry-After ×
    // 1.5^fails, 1h cap) to give the aggregated limit room to recover. Keeps the
    // last good value (or plan-only). Other failures (401/offline) → plan-only.
    if (e && e.statusCode === 429) {
      const baseMs = (typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0)
        ? e.retryAfterMs : CLAUDE_429_COOLDOWN_MS;
      const fails = (cached && cached.fails) || (cooldownFails || 0);
      const backoff = Math.min(CLAUDE_429_MAX_BACKOFF_MS,
        Math.round(baseMs * Math.pow(CLAUDE_429_BACKOFF_FACTOR, fails)));
      const until = nowMs + backoff;
      const keep = (cached && cached.entries) ? cached.entries : planOnly;
      _claudeCacheByToken.set(token, { at: nowMs, entries: keep, cooldownUntil: until, fails: fails + 1 });
      // Persists {until, fails} (only timestamps/counter, never the token) for restart.
      if (typeof setCooldown === 'function') { try { setCooldown({ until, fails: fails + 1 }); } catch { /* never breaks the collection */ } }
      return keep;
    }
    return planOnly; // expired token/offline → plan-only (doesn't clutter with ⚠)
  }
  const windows = parseAnthropicUsage(payload, nowMs);
  if (!windows.length) return planOnly;
  // stable id per window (5h/7d/extra) — 'Extra' (overage) must NOT collide
  // with 7d; an explicit map avoids the ternary that dumped everything into '7d'.
  const idByTitle = { '5 h': 'claude-5h', '7 dias': 'claude-7d', 'Extra': 'claude-extra' };
  const entries = windows.map((w) => ({
    id: idByTitle[w.title] || 'claude-' + String(w.title).replace(/\s+/g, ''),
    agent: 'claude',
    title: w.title,
    plan,
    usedPct: w.usedPct,
    resetAt: w.resetAt,
    resetInMin: w.resetInMin,
    extra: w.extra || null,          // 'Extra' carries "$50.4/$50"; windows don't have one
    source: 'anthropic.oauth',
    error: null,
  }));
  _claudeCacheByToken.set(token, { at: nowMs, entries, fails: 0 });
  // Success → clears the persisted backoff (releases for future normal collections).
  if (typeof setCooldown === 'function') { try { setCooldown({ until: 0, fails: 0 }); } catch { /* never breaks the collection */ } }
  return entries;
}
function _clearClaudeCache() { _claudeCacheByToken.clear(); }


// ---- Codex (OpenAI, ChatGPT plan) — PASSIVE, no network ----
// Usage lives in the session rollout: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// The LAST token_count event has payload.rate_limits (real % and reset of the
// 5h/weekly windows). We associate the rollout with the live session by cwd (the
// rollout's session_meta has cwd; main.js passes the cwd read from /proc/<pid>/cwd).
// Everything injectable (sessionsDir, readFile, listFiles) → testable without disk.

// Finds the path of the most recent rollout whose session_meta.cwd == target cwd.
// `files` is the list of absolute rollout paths (most recent first is
// ideal, but we sort by mtime via statMtime). Pure-ish: I/O via callbacks.
function findCodexRollout(cwd, opts = {}) {
  const listFiles = opts.listFiles || defaultListRollouts;
  const readHead = opts.readHead || defaultReadHead;
  const statMtime = opts.statMtime || defaultMtime;
  let files;
  try { files = listFiles(opts.sessionsDir); } catch { return null; }
  if (!Array.isArray(files) || !files.length) return null;
  // sorts by mtime desc (the active rollout is the most recently written)
  const sorted = files.map((f) => ({ f, m: statMtime(f) })).sort((a, b) => b.m - a.m);
  for (const { f } of sorted) {
    let head;
    try { head = readHead(f); } catch { continue; }   // 1st line = session_meta
    let meta;
    try { meta = JSON.parse(head); } catch { continue; }
    const mcwd = meta && (meta.payload ? meta.payload.cwd : meta.cwd);
    if (mcwd === cwd) return f;
  }
  return null;
}

// Extracts the rate_limits from the LAST token_count of an already-read rollout (JSONL
// string). Pure/testable. Returns the rate_limits object or null.
function lastCodexRateLimits(jsonl) {
  if (typeof jsonl !== 'string') return null;
  let found = null;
  for (const line of jsonl.split('\n')) {
    if (!line || line.indexOf('token_count') === -1) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    // The event is {type:'event_msg', payload:{type:'token_count', rate_limits}}.
    const p = o && o.payload;
    if (p && p.type === 'token_count' && p.rate_limits) {
      found = p.rate_limits; // overwrites → keeps the LAST token_count
    }
  }
  return found;
}

// Reads Codex usage for a cwd. Cache per cwd, 30s. Never throws.
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

// Codex default I/O (used in production; tests inject their own).
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
  // Reads only the 1st line (session_meta) — but it can be LARGE: Codex embeds the
  // whole system prompt in payload.base_instructions (tens of KB). Reads in
  // chunks up to the first \n (with a safety cap) instead of a fixed buffer,
  // otherwise JSON.parse breaks on a line cut in the middle.
  const fd = fs.openSync(f, 'r');
  try {
    const CHUNK = 65536, MAX = 4 * 1024 * 1024; // 4MB cap for the 1st line
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
// PASSIVE, no network. Two sources:
//  1. LABEL: the active model in ~/.gemini/antigravity-cli/settings.json.
//  2. EXHAUSTED QUOTA: the conversation DBs (~/.gemini/antigravity-cli/conversations/
//     *.db) record the API's QUOTA_EXHAUSTED error response, which carries the
//     quotaResetTimeStamp (weekly reset). Google does NOT expose a continuous % — we
//     only know "exhausted" when it blows. So: with quota → label only (—);
//     exhausted → usedPct=100 (full/red bar) + reset.
// Synchronous (does no network) → collectUsage wraps it in a Promise.resolve.

// Pure parser: extracts the label from the already-read settings object. Testable.
function parseAntigravityTier(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const model = settings.model || settings.selectedModel || settings.defaultModel;
  if (!model || typeof model !== 'string') return { model: null };
  return { model };
}

// Pure parser: finds the QUOTA_EXHAUSTED with the LARGEST quotaResetTimeStamp in a text
// (the raw content of a .db, read as a string). Returns {resetAt} ISO or null.
// Regex-based (the .db is binary/protobuf; the error JSONs stay readable inside).
function parseAntigravityQuota(dbText, now) {
  if (typeof dbText !== 'string') return null;
  // Ignores the AI traffic light's own technical support conversations that contain
  // discussions of the quota code and generate test false positives.
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

    // Confirms QUOTA_EXHAUSTED is nearby (limits the window to 250 characters before/after)
    const idx = m.index;
    const start = Math.max(0, idx - 250);
    const end = Math.min(dbText.length, idx + 250);
    const context = dbText.slice(start, end);
    if (/"reason"\s*:\s*"QUOTA_EXHAUSTED"/.test(context)) {
      if (ms > bestTs) { bestTs = ms; bestAt = tsStr; }
    }
  }
  // only counts if the reset is in the FUTURE (quota really exhausted now).
  if (bestAt && bestTs > nowMs) return { resetAt: bestAt };
  return null;
}

// Reads Antigravity usage. Label from settings.json + quota state from the
// conversation DBs (the most recent by mtime). No settings → null. Never throws.
// Injectable I/O (readFile, listDbs, readDb, mtime) for testing.
function readAntigravityUsage({ home, now, readFile, listDbs, readDb, mtime } = {}) {
  const base = path.join(home || os.homedir(), '.gemini', 'antigravity-cli');
  let settings;
  try {
    const raw = (readFile || ((f) => fs.readFileSync(f, 'utf8')))(path.join(base, 'settings.json'));
    settings = JSON.parse(raw);
  } catch { return null; } // no Antigravity configured
  const t = parseAntigravityTier(settings);
  if (!t) return null;

  // exhausted quota: checks RECENT conversation DBs (modified in the last 2h).
  // Old DBs may contain quota errors from a previous plan that has since been
  // upgraded — they must not affect the current status.
  const QUOTA_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
  let quota = null;
  try {
    const list = (listDbs || defaultListAntigravityDbs)(base);
    const stat = mtime || ((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } });
    const read = readDb || ((f) => fs.readFileSync(f, 'latin1'));
    const nowMs = now || Date.now();
    // Filters only those modified in the last 2h, sorting by most recent first.
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
  } catch { /* no DBs / no permission → carries on with label only */ }

  const nowMs = now || Date.now();
  const plan = t.model ? 'Antigravity (' + t.model + ')' : 'Antigravity';
  if (quota) {
    const resetInMin = Math.max(0, Math.round((Date.parse(quota.resetAt) - nowMs) / 60000));
    return [{
      id: 'antigravity-quota', agent: 'antigravity', title: 'Cota', plan,
      usedPct: 100,                        // exhausted → full (red) bar
      resetAt: quota.resetAt, resetInMin, extra: null,
      source: 'antigravity.quota', error: null,
    }];
  }
  return [{
    id: 'antigravity-plan', agent: 'antigravity', title: 'Cota', plan,
    usedPct: null,                         // with quota → no number (label only)
    resetAt: null, resetInMin: null, extra: null,
    source: 'antigravity.settings', error: null,
  }];
}

// Lists Antigravity's conversation .db files (default I/O; tests inject their own).
function defaultListAntigravityDbs(base) {
  const dir = path.join(base, 'conversations');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => path.join(dir, f)); }
  catch { return []; }
}

// Converts the Retry-After header to ms. Accepts both HTTP formats: a
// SECONDS number ("1007") or an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT").
// `now` in ms (injectable for testing). Returns ms >= 0, or null if unreadable.
function parseRetryAfter(header, now) {
  if (header == null) return null;
  const s = String(header).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;   // delta-seconds
  const when = Date.parse(s);                             // HTTP-date
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - (now || Date.now()));
}

// Makes an HTTPS GET with an injectable `fetcher` (testable). In production uses https.get.
// Returns the parsed JSON or throws (the caller catches).
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
          // Attaches metadata to the error so the caller can decide backoff (429 → cooldown).
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

// Reads the GLM quota via the monitor API. Requires ANTHROPIC_BASE_URL (z.ai or
// bigmodel) + ANTHROPIC_AUTH_TOKEN in env. No credentials → null (omitted).
// Cache PER TOKEN (not global): distinct z.ai accounts in distinct terminals
// don't overwrite each other in the cache. `label`/`suffix` distinguish accounts in the
// UI when there is more than one (multi-account); with 1 account they stay empty and the id stays canonical.
const CACHE_MS = 30 * 1000;
// Claude has its OWN, longer cache: the /api/oauth/usage API is heavily
// rate-limited (Retry-After ~1000s) and the windows are 5h/7d — the % barely
// changes within minutes. 5 min = at most 12 req/h, takes pressure off the endpoint. (GLM stays at 30s.)
const CLAUDE_CACHE_MS = 5 * 60 * 1000; // 5 min
// Default cooldown when the 429 carries no readable Retry-After (conservative fallback).
const CLAUDE_429_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
// Exponential backoff: on each CONSECUTIVE 429 the app waits longer and longer
// before trying (Retry-After × 1.5^fails), up to the cap. Avoids the "cooldown expires →
// re-hit → 429 again → re-arm" cycle that kept the aggregated limit blown (the
// same endpoint is queried by Claude Code itself in /status). 1h cap.
const CLAUDE_429_BACKOFF_FACTOR = 1.5;
const CLAUDE_429_MAX_BACKOFF_MS = 60 * 60 * 1000;
const _glmCacheByToken = new Map(); // token → { at, entries }
async function readGlmUsage({ env, now, fetcher, label, suffix } = {}) {
  const E = env || process.env;
  const base = E.ANTHROPIC_BASE_URL || '';
  const token = E.ANTHROPIC_AUTH_TOKEN || '';
  if (!token || !base) return null;
  if (!/api\.z\.ai|bigmodel\.cn/.test(base)) return null; // non-GLM backend

  const nowMs = now || Date.now();
  const cached = _glmCacheByToken.get(token);
  if (cached && (nowMs - cached.at) < CACHE_MS) return cached.entries;

  const parsed = new URL(base);
  const domain = `${parsed.protocol}//${parsed.host}`;
  const quotaUrl = `${domain}/api/monitor/usage/quota/limit`;
  const headers = { Authorization: token, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' };
  const sfx = suffix ? ':' + suffix : '';       // unique id per account (renderer key)
  const planTag = label ? ' (' + label + ')' : ''; // human label of the account

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
  // No limits parsed = payload with unknown schema. Even so we
  // return a "GLM" entry marking that the account exists (active source),
  // but without a number — honest, doesn't invent one.
  const result = entries.length ? entries : [{
    id: 'glm' + sfx, agent: 'glm', title: 'GLM' + planTag, usedPct: null, resetAt: null,
    resetInMin: null, extra: null, source: 'glm.api', error: 'no limits parsed',
  }];
  _glmCacheByToken.set(token, { at: nowMs, entries: result });
  return result;
}

// Clears the cache (tests / credential change).
function _clearGlmCache() { _glmCacheByToken.clear(); }

const _opencodeCacheByToken = new Map(); // token → { at, entries }

// Reads usage from the OpenCode Go API (https://opencode.ai/zen/go/v1/usage)
async function readOpencodeUsage({ env, now, fetcher, label, suffix } = {}) {
  const token = env && env.OPENCODE_AUTH_TOKEN;
  if (!token) return null;
  const nowMs = now || Date.now();
  const cached = _opencodeCacheByToken.get(token);
  if (cached && nowMs - cached.at < 30000) return cached.entries;

  const planBase = label || 'OpenCode Go';
  const planTag = suffix ? ` (${suffix})` : '';
  const sfx = suffix ? `:${suffix}` : '';

  let raw = null;
  try {
    raw = await _httpsGetJson(
      'https://opencode.ai/zen/go/v1/usage',
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      fetcher
    );
  } catch (err) {
    const result = [{
      id: 'opencode' + sfx, agent: 'opencode', title: 'OpenCode' + planTag, usedPct: null,
      resetAt: null, resetInMin: null, extra: null, source: 'opencode.api', error: err.message || 'fetch error',
    }];
    _opencodeCacheByToken.set(token, { at: nowMs, entries: result });
    return result;
  }

  const windows = parseOpencodeUsage(raw, nowMs);
  const entries = windows.map((w, i) => ({
    id: `opencode-win${i}${sfx}`,
    agent: 'opencode',
    title: w.title,
    plan: planBase + planTag,
    usedPct: w.usedPct,
    resetAt: w.resetAt,
    resetInMin: w.resetInMin,
    extra: w.status === 'exhausted' ? 'esgotado' : null,
    source: 'opencode.api',
    error: null,
  }));

  const result = entries.length ? entries : [{
    id: 'opencode' + sfx, agent: 'opencode', title: 'OpenCode' + planTag, usedPct: null, resetAt: null,
    resetInMin: null, extra: null, source: 'opencode.api', error: 'no limits parsed',
  }];
  _opencodeCacheByToken.set(token, { at: nowMs, entries: result });
  return result;
}

function _clearOpencodeCache() { _opencodeCacheByToken.clear(); }

// Stable suffix for the multi-account Claude account (#58; same pattern as GLM):
// sha256-6 of the uuid — the dir can change name (renamed profile) without losing
// the merge history. Exported: main.js uses the SAME sfx to map the nickname
// rename (renderer sends accountId=sfx → main resolves uuid → saves the label).
function claudeAccountSfx(src) {
  try { return require('crypto').createHash('sha256').update(String(src)).digest('hex').slice(0, 6); }
  catch { return String(src).slice(0, 6); }
}

// Claude account IDENTITY key — ONE definition (review fix #9: there were 4
// equal-but-not-identical expressions scattered across collectUsage,
// claudeAccountsFromSessions, annotate and the tile's sfx; divergence = dedup
// that doesn't dedupe, or a rename saved under a key no read matches).
// Precedence: orgUuid (billing/limit per org, #60) > accountUuid (personal
// accounts) > dir (profile WITHOUT oauth — proxy/API key, .claude.json without
// oauthAccount: local identity, and its tile needs to be renamable) >
// 'default' (symlink account). Pure and exported.
function claudeAccountKey(pc, dir) {
  return (pc && (pc.accountOrgUuid || pc.accountUuid)) || dir || 'default';
}

// Label for a Claude account (#58): manual nickname > org name >
// email local-part (the FULL email never shows; the cut happens here) >
// profile dir basename (without the dot: ~/.gh-claude → 'gh-claude').
// Pure and exported — used by the usage bar (collectUsage) and by main to
// label each session's account (details modal). A single source of precedence.
function accountLabel(pc, dir, manual) {
  if (manual) return manual;
  if (pc && pc.accountName) return pc.accountName;
  if (pc && pc.accountEmail) return String(pc.accountEmail).split('@')[0];
  if (dir) { const b = String(dir).replace(/\/+$/, '').split('/').pop().replace(/^\.+/, ''); if (b) return b; }
  return null;
}

// Profile's alternative API provider (session details): the config dir's
// settings.json can swap Claude Code's API for a custom proxy/router
// (env.ANTHROPIC_BASE_URL — e.g. ~/.gh-claude points to vm-contabo, which routes
// GLM). Returns a readable host[:port] to compose "gh-claude · vm-contabo:20128",
// or null when the profile uses the official API (no base_url). Pure and exported —
// main composes the suffix in each session's account label. The AUTH_TOKEN in the
// same `env` block is NEVER read/returned.
function apiProviderFromSettings(dir) {
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(claudePaths.settingsFile({ dir }), 'utf8');
    const url = ((JSON.parse(raw) || {}).env || {}).ANTHROPIC_BASE_URL;
    if (!url) return null;
    const u = new URL(String(url));
    const port = u.port && u.port !== '80' && u.port !== '443' ? ':' + u.port : '';
    return u.hostname + port;
  } catch { return null; }
}

// =========================== ORCHESTRATOR ===========================

// Joins all sources. Stable order: Claude (local) first, GLM after.
// `now` in ms. Always resolves (never rejects) — errors become entries or omission.
//
// GLM multi-account: opts.glmCreds is a list of distinct credentials (one per
// z.ai account) collected from the running AIs —
//   [{ env:{ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN}, label?, suffix? }]
// Each running AI gets its usage fetched with ITS OWN credentials; equal accounts
// (same token) already come deduplicated from whoever builds the list (main.js). Fallback:
// opts.env (one credential) keeps the old contract/tests. GLMs run in
// parallel (Promise.all) — independent network I/O per account.
async function collectUsage(opts = {}) {
  const out = [];

  const creds = Array.isArray(opts.glmCreds) && opts.glmCreds.length
    ? opts.glmCreds
    : (opts.env ? [{ env: opts.env }] : []);
  const multi = creds.length > 1;              // >1 account → labels each block

  // Claude multi-account (#58): opts.claudeAccounts = [{ dir, label? }] —
  // main.js collects the CLAUDE_CONFIG_DIRs from the live sessions' environs
  // (dir null = the default ~/.claude symlink account). Identity dedup
  // happens HERE, not in main: only whoever reads each dir's .claude.json knows
  // the uuids. Identity = organizationUuid || accountUuid: billing/rate
  // limit are per ORG — same login in two Team orgs (same accountUuid,
  // different organizationUuid) are TWO accounts; a personal account without org dedupes
  // by accountUuid (two profiles, same login → one bar). Fallback without
  // claudeAccounts = 1 default account — canonical ids, UI identical to today.
  const accountsIn = Array.isArray(opts.claudeAccounts) && opts.claudeAccounts.length
    ? opts.claudeAccounts
    : [{ dir: null }];
  const seenKey = new Set();
  const claudeAccounts = [];
  for (const a of accountsIn) {
    if (!a) continue;
    const pc = readClaudeConfig({ home: opts.home, now: opts.now, dir: a.dir });
    // claudeAccountKey (one definition, review #9): key is never null — an
    // account without oauth dedupes by dir (distinct profiles remain 2 bars).
    const key = claudeAccountKey(pc, a.dir);
    if (seenKey.has(key)) continue;             // same org/login in another profile → 1 bar
    seenKey.add(key);
    claudeAccounts.push({ dir: a.dir, label: a.label, pc, key });
  }
  const multiClaude = claudeAccounts.length > 1;

  // Bar label (#58): given nickname (account-labels.json) > org name >
  // email local-part (the full email never shows; the cut happens here) >
  // dir basename. Falling back to the plan distinguishes nothing (2 bars, same plan) —
  // the profile name is local, from the user's own machine, and distinguishes.
  // The precedence lives in accountLabel (exported) — main reuses it to label
  // EACH SESSION's account in the details modal; a single source.
  const claudeAccountLabel = (acc) => accountLabel(acc.pc, acc.dir, acc.label);

  // Claude accounts + OpenCode Go + all GLM accounts in parallel — independent
  // network I/O. Claude uses opts.claudeFetcher (separate from GLM/OpenCode's:
  // each API has its own schema/mock; in tests without claudeFetcher and without a token,
  // Claude falls back to plan-only).
  const results = await Promise.all([
    ...claudeAccounts.map((acc) => {
      // The 429 cooldown is PER ACCOUNT (opts.claudeCooldowns = { key: {until, fails} },
      // persisted by main). The old GLOBAL cooldown silenced the healthy
      // accounts along: a 429 from account A made B return stale/planOnly
      // for the whole window — and a restart midway (empty per-token cache) left
      // B plan-only without ever having taken a 429. The key is the account identity
      // (org/account uuid — the same one as the dedup), with dir as fallback.
      const cdKey = acc.key || acc.dir || 'default';
      const cd = (opts.claudeCooldowns && opts.claudeCooldowns[cdKey]) || { until: 0, fails: 0 };
      return readClaudeUsage({
        home: opts.home, dir: acc.dir, now: opts.now, fetcher: opts.claudeFetcher,
        cooldownUntil: cd.until, cooldownFails: cd.fails,
        setCooldown: (v) => {
          if (typeof opts.claudeSetCooldown === 'function') { try { opts.claudeSetCooldown(cdKey, v); } catch { /* never breaks the collection */ } }
        },
        // Lazy: only hits the Claude API when the caller asks (UI trigger).
        // main.js passes true when opening/revealing the overlay and on ⟳; the
        // background loop omits it → false. Default true preserves the tests/direct-use contract.
        allowFetch: opts.claudeAllowFetch !== false,
      }).catch(() =>
        // Unexpected reader exception (network/429/offline it swallows itself and
        // returns planOnly/last good — the catch only sees the unforeseen). The account
        // is ALIVE (only live sessions discovered it): returning null would make it
        // vanish from fresh and mergeUsage's prune would read "account closed",
        // killing the last good value RIGHT AWAY (review, prune fix). Instead,
        // its plan-only tile (acc.pc was already read in the dedup) marks the
        // family as alive — the prune respects it and the merge holds prev for
        // DROP_MS (stale) like any line that didn't come in this collection.
        claudePlanOnlyTile(acc.pc && acc.pc.plan || null, acc.pc, acc.dir));
    }),
    Promise.resolve().then(() => readAntigravityUsage({ home: opts.home })).catch(() => null),
    readOpencodeUsage({
      env: opts.opencodeEnv, now: opts.now, fetcher: opts.fetcher,
      label: opts.opencodeLabel, suffix: opts.opencodeSuffix,
    }).catch(() => null),
    ...creds.map((c) => readGlmUsage({
      env: c.env, now: opts.now, fetcher: opts.fetcher,
      label: multi ? c.label : undefined,
      suffix: multi ? c.suffix : undefined,
    }).catch(() => null)),                       // readGlmUsage already catches; double defense
  ]);
  const nClaude = claudeAccounts.length;
  const antigravity = results[nClaude];
  const opencode = results[nClaude + 1];
  const glm = results.slice(nClaude + 2);

  // Claude: >1 account → suffixed id (claude-5h:<sfx>, like glm-month:<sha>) +
  // account/accountId fields for the renderer and the nickname rename. 1 account →
  // canonical ids, no new fields (zero regression in the 1-account UI).
  results.slice(0, nClaude).forEach((entries, i) => {
    if (!Array.isArray(entries)) return;
    const acc = claudeAccounts[i];
    if (!multiClaude) { out.push(...entries); return; }
    // sfx from the UNIQUE key (review #9): acc.key already carries the fallbacks —
    // the tile's accountId matches the rename's lastAccountIds on EVERY account,
    // including proxies without oauth (key = dir).
    const sfx = claudeAccountSfx(acc.key);
    const label = claudeAccountLabel(acc);
    for (const e of entries) {
      // Copying is mandatory: `entries` may be THE live array from the per-token
      // cache (_claudeCacheByToken returns by reference) — mutating e.id in place
      // contaminated the cache and the suffix piled up every round (id
      // 'claude-5h:<sfx>:<sfx>'). The spread isolates the entry from the cache (#58).
      out.push({ ...e, id: e.id + ':' + sfx, accountId: sfx, ...(label ? { account: label } : {}) });
    }
  });
  if (Array.isArray(antigravity)) out.push(...antigravity);
  if (Array.isArray(opencode)) out.push(...opencode);

  // Codex (passive, no network): one read per distinct cwd of live Codex sessions.
  // opts.codexCwds = ['/home/x/proj', ...] (main.js collects from /proc/<pid>/cwd).
  const codexCwds = [...new Set(Array.isArray(opts.codexCwds) ? opts.codexCwds.filter(Boolean) : [])];
  const multiCodex = codexCwds.length > 1;     // >1 project → distinguishes in the label
  for (const cwd of codexCwds) {
    let entries = null;
    try { entries = readCodexUsage({ cwd, now: opts.now, ...(opts.codexIO || {}) }); } catch { /* never breaks */ }
    if (!Array.isArray(entries)) continue;
    if (multiCodex) {                          // labels by the project folder
      const proj = cwd.split('/').filter(Boolean).pop() || cwd;
      // spread: same protection as Claude — never mutate the reader's output (cache)
      for (const e of entries) out.push({ ...e, plan: e.plan + ' · ' + proj, id: e.id + ':' + proj });
    } else {
      out.push(...entries);
    }
  }

  for (const r of glm) if (Array.isArray(r)) out.push(...r);
  return out;
}

// "Aging" windows for a usage line (ms). After STALE_MS without
// an update, the line is marked stale=true (the UI paints it gray). After
// DROP_MS, it disappears (session probably closed). A NEW good value resets the clock.
const USAGE_STALE_MS = 4 * 60 * 1000;   // ~4 min → gray
const USAGE_DROP_MS = 20 * 60 * 1000;   // ~20 min → removed

// "Summary/degraded" tile: represents an agent WITHOUT a concrete window — the
// Claude plan-only (claude.json, no %) or the GLM whose limits weren't
// parsed / the call failed. It must not coexist with concrete tiles
// (claude-5h/7d, glm-tokens/month) of the same agent: when the collection oscillates
// between OK (real) and failure (fallback) across ticks, this avoids "Claude Max" and
// "Claude Max 5× - 5 h" on the same screen. (issue: overlay sometimes duplicating tiles.)
// glm:suffix is multi-account; glm-tokens/month (with a hyphen) are NOT summary.
// claude-plan:zzzzzz is the plan-only of ONE multi-account account (suffixed id).
function isSummaryEntry(e) {
  if (!e || !e.id) return false;
  const id = String(e.id);
  return id === 'claude-plan' || id.startsWith('claude-plan:') || id === 'antigravity-plan' || id === 'glm' || id.startsWith('glm:') || id === 'opencode' || id.startsWith('opencode:');
}

// Legacy of the in-place cache mutation bug (accumulated suffix 'a:sfx:sfx'):
// collapses repeated consecutive segments so the id merges with the
// post-fix fresh instead of becoming an orphan for DROP_MS. Idempotent.
function collapseSuffixId(id) {
  const parts = String(id).split(':');
  for (let i = parts.length - 1; i > 0; i--) if (parts[i] === parts[i - 1]) parts.splice(i, 1);
  return parts.join(':');
}

// Merges the new collection (fresh) with the previous state (prev), by `id`. Fixes the
// "counters reset when the data doesn't come" bug: instead of replacing everything,
// it keeps the LAST good value of each line until a new one arrives. Rules per id:
//   • fresh has a good value (usedPct != null, no error) → adopt, fetchedAt=now, stale=false
//   • fresh came bad (null/error) but prev had a value → keep prev, mark stale if old
//   • id only in prev (didn't come in this collection) → keep, mark stale/drop by age
//   • new id without a value → pass through as-is (honest first appearance)
// `now` in ms. Returns the merged list (order: fresh first, then orphans from
// prev that haven't expired), each item with fetchedAt and stale.
function mergeUsage(prev, fresh, now) {
  const nowMs = now || Date.now();
  // Normalizes the legacy accumulated suffix (a:sfx:sfx → a:sfx) on both ends.
  const norm = (list) => (Array.isArray(list) ? list : [])
    .map((e) => (e && e.id ? { ...e, id: collapseSuffixId(e.id) } : e));
  const freshList = norm(fresh);
  const prevById = new Map();
  for (const p of norm(prev)) if (p && p.id) prevById.set(p.id, p);

  // Single↔multi account oscillation (#58): agent ids change according to the
  // number of LIVE accounts at the moment of collection (claude-5h ↔ claude-5h:<sfx>,
  // glm-tokens ↔ glm-tokens:<sha>). When the mode changes between ticks (the 2nd
  // account's session opens/closes, rename re-collects right away), the two families
  // would coexist for DROP_MS — the SAME account in 2 bars. The fresh is the
  // truth of the moment: the family it doesn't bring dies immediately.
  const freshSfxByBase = new Map(); // 'claude-5h' → Set of suffixes that came
  const freshCanonical = new Set(); // 'claude-5h' that came exactly (no suffix)
  const freshSfxAll = new Set();    // every live suffix from fresh, on any base
  for (const f of freshList) {
    if (!f || !f.id) continue;
    const i = f.id.indexOf(':');
    if (i > 0) {
      const base = f.id.slice(0, i);
      if (!freshSfxByBase.has(base)) freshSfxByBase.set(base, new Set());
      freshSfxByBase.get(base).add(f.id.slice(i + 1));
      freshSfxAll.add(f.id.slice(i + 1));
    } else freshCanonical.add(f.id);
  }
  for (const id of [...prevById.keys()]) {
    const i = id.indexOf(':');
    if (i > 0) {
      // multi→single: fresh canonical on the base → suffixed prev dies.
      // multi→multi: fresh brings the base with OTHER suffixes → the suffix is the
      // account identity; prev with a suffix outside fresh is the OLD key of the
      // same account (key migration, e.g. #58 accountUuid → #60 orgUuid:
      // claude-5h:ffdc8e + claude-5h:39e493 duplicated the Artemis bar) or an
      // account that closed — in both cases the suffix is GONE from the whole fresh.
      // Exception (review): a live suffix in ANOTHER base is a LIVE account whose
      // collection degraded — only its plan-only came (claude-plan:<sfx> from 401/offline/
      // exception; glm:<sha> likewise). It isn't "closed": its concrete prev follows
      // the normal missing-line regime — stale until DROP_MS, not immediate
      // death (the good bar must not blink out over a network blip).
      const sfx = id.slice(i + 1);
      const sfxs = freshSfxByBase.get(id.slice(0, i));
      if (freshCanonical.has(id.slice(0, i))
        || (sfxs && !sfxs.has(sfx) && !freshSfxAll.has(sfx))) prevById.delete(id);
    } else if (freshSfxByBase.has(id)) prevById.delete(id); // single→multi
  }

  // If the new collection brings the Antigravity plan, clears the exhausted quota from the previous cache.
  const freshIds = new Set(freshList.map((f) => f && f.id).filter(Boolean));
  if (freshIds.has('antigravity-plan')) {
    prevById.delete('antigravity-quota');
  }

  const seen = new Set();
  const out = [];

  const isGood = (e) => e && e.usedPct != null && !e.error;

  for (const f of freshList) {
    if (!f || !f.id) { out.push(f); continue; }
    seen.add(f.id);
    const p = prevById.get(f.id);
    if (isGood(f)) {
      out.push({ ...f, fetchedAt: nowMs, stale: false });
    } else if (isGood(p)) {
      // the current collection failed for this line, but we had a good value: keep it.
      const age = nowMs - (p.fetchedAt || nowMs);
      out.push({ ...p, stale: age >= USAGE_STALE_MS });
    } else {
      // we never had a good value: pass fresh through as-is (honest).
      out.push({ ...f, fetchedAt: f.fetchedAt || nowMs, stale: false });
    }
  }

  // Lines that existed before but did NOT come in this collection (the collector
  // vanished for a tick): keep until DROP_MS, marking stale after STALE_MS.
  for (const [id, p] of prevById) {
    if (seen.has(id)) continue;
    const age = nowMs - (p.fetchedAt || nowMs);
    if (age >= USAGE_DROP_MS) continue;               // too old → disappears
    if (!isGood(p)) continue;                          // never had a value → don't hold it
    out.push({ ...p, stale: age >= USAGE_STALE_MS });
  }

  // Semantic dedup: a "summary" tile (claude-plan / glm without limits) is
  // redundant if a concrete tile of the same agent already exists (coming from fresh or
  // held as a good orphan above). It appears when the collection oscillates between
  // OK and failure across ticks — without this, summary and concrete coexist on the same screen.
  // PER FAMILY (agent + account suffix), not per agent: in multi-account, the
  // plan-only of account B (claude-plan:ca2705 — token failed/no window) coexists
  // with the concrete tiles of account A (claude-5h:ffdc8e). Filtering by pure agent
  // wiped out B's ENTIRE bar (#58). Canonical ↔ canonical stays the same
  // (family without suffix).
  const fam = (e) => {
    const id = String(e && e.id || '');
    const i = id.indexOf(':');
    return (e && e.agent || '?') + '|' + (i > 0 ? id.slice(i + 1) : '');
  };
  const concreteFams = new Set();
  for (const e of out) if (e && !isSummaryEntry(e) && e.agent) concreteFams.add(fam(e));
  let deduped = concreteFams.size
    ? out.filter((e) => !isSummaryEntry(e) || !concreteFams.has(fam(e)))
    : out;

  // Dedup by CONTENT (same account, different tokens): the same z.ai account can
  // arrive via N credentials (subprocess in /proc, OpenCode auth.json, terminal)
  // with distinct ids/suffixes, but the lines are IDENTICAL (same agent, same
  // window, same reset). Collapses by semantic key — keeps the one with a good
  // value and the most recent fetchedAt. Fixes "GLM appearing many times".
  const byContent = new Map();
  for (const e of deduped) {
    if (!e) continue;
    // Normalizes the GLM provider label (" (z.ai)"/" (bigmodel.cn)") before
    // generating the key: the SAME account can arrive canonical (1 account → plan 'GLM Pro',
    // id 'glm-month') or suffixed (multi-account → plan 'GLM Pro (z.ai)', id
    // 'glm-month:hash') depending on how the number of accounts oscillates across ticks, or linger
    // as a legacy leftover in usage.json. Without this the two versions have different
    // keys and don't collapse → GLM appears duplicated ("z.ai 2×").
    const planNorm = String(e.plan || '').replace(/\s*\((z\.ai|bigmodel\.cn)\)\s*$/, '').trim();
    // Normalizes resetAt to SECONDS in the key: the same account arriving via 2
    // credentials (distinct tokens) gets resetAt from the API differing by ~1ms
    // ("...09.995Z" vs "...09.996Z") — without this, the key differs and the monthly tile
    // appears duplicated ("z.ai Pro mês 2×"). Truncates sub-second; truly distinct
    // accounts have resets separated by far more than 1s.
    const resetMs = e.resetAt ? Date.parse(e.resetAt) : NaN;
    const resetKey = Number.isNaN(resetMs) ? '' : Math.floor(resetMs / 1000);
    // `account` (Claude multi-account, #58) enters the key: two accounts with the
    // same plan and the same window are DIFFERENT lines — without this, content
    // dedup would collapse them into a single bar.
    const key = [e.agent, e.title || '', e.account || '', planNorm, resetKey].join('|');
    const prev = byContent.get(key);
    if (!prev) { byContent.set(key, e); continue; }
    // picks the best: good value > less stale > more recent fetchedAt.
    const better = (isGood(e) && !isGood(prev)) ? e
      : (isGood(prev) && !isGood(e)) ? prev
      : ((e.fetchedAt || 0) >= (prev.fetchedAt || 0) ? e : prev);
    byContent.set(key, better);
  }
  return [...byContent.values()];
}

// Parses the contents of /proc/<pid>/environ (KEY=val pairs separated by NUL)
// and returns only the requested keys. Pure (testable) — the I/O of reading the file stays
// in main.js. Used to extract ANTHROPIC_BASE_URL/AUTH_TOKEN from the GLM terminal.
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

// ======================= detectReset ("cota resetou" quota-reset notice) =======================
// Decides WHEN to notify that a limit that was EXHAUSTED has just reset (the
// quota freed up again). Reconciles by state TRANSITION between collections — it does not
// schedule a timer at resetAt — so it survives the app sleeping/hibernating and lost
// collections: main.js's 60s loop compares before/after on every tick.
//
// PURE FUNCTION: uses no Date.now() and fires no Notification. main.js injects the
// clock (`now`) and performs the side effect. Testable with a fixed `now` — the cases
// in test/usage.test.js are the specification.
//
// Parameters:
//   prevState — state from the previous call by id: { [id]: { resetAtMs, armed } }
//               (or null/undefined on the 1st collection).
//   entries   — current usage entries: [{ id, usedPct, resetAt, plan, title, ... }].
//   now       — epoch in ms (injected).
//   threshold — usage % that "arms" the notice (0–100). armed = usedPct >= threshold.
// Returns:
//   { toNotify, nextState } — toNotify = entries that reset while armed;
//                             nextState = state to pass to the next call.
function detectReset(prevState, entries, now, threshold) {
  const prev = prevState || {};
  const nextState = {};
  const toNotify = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.id || nextState[e.id]) continue;       // no id, or id already seen in this tick → dedupe
    if (!e.resetAt) continue;                            // no reset time → can't detect
    const resetAtMs = Date.parse(e.resetAt);
    if (Number.isNaN(resetAtMs)) continue;             // malformed resetAt → ignore
    const armed = typeof e.usedPct === 'number' && e.usedPct >= threshold;
    const p = prev[e.id];                              // previous state of this limit (or undefined)

    // Reset while armed? The clock passed the resetAt of the PREVIOUS read AND
    // the limit was exhausted in that read — at the moment of the reset the % has
    // already dropped, so "was exhausted" only exists in `p`. (Only `now >= p.resetAtMs`: before there
    // was `|| resetAtMs > p.resetAtMs`, but it was a false positive when the API
    // extended resetAt early without actually resetting.)
    const windowTurned = !!p && now >= p.resetAtMs;
    const resetou = windowTurned && p.armed;
    if (resetou) toNotify.push(e);
    // Re-arms by the current %, but "sticks" armed while the SAME window continues:
    // a downward dip of the % before the reset must not disarm the notice.
    // In a new window (after reset) it does NOT re-stick → dedupe on the next tick.
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
  parseClaudeConfig, parseAnthropicUsage, parseGlmQuota, parseCodexRateLimits, parseAntigravityTier, parseAntigravityQuota, parseOpencodeUsage,
  readClaudeConfig, readClaudeUsage, readGlmUsage, readCodexUsage, readAntigravityUsage, readOpencodeUsage, collectUsage, parseEnviron,
  findCodexRollout, lastCodexRateLimits, mergeUsage, isSummaryEntry, detectReset, parseRetryAfter,
  USAGE_STALE_MS, USAGE_DROP_MS, CLAUDE_429_COOLDOWN_MS, CLAUDE_CACHE_MS,
  CLAUDE_429_BACKOFF_FACTOR, CLAUDE_429_MAX_BACKOFF_MS,
  _clearGlmCache, _clearClaudeCache, _clearCodexCache, _clearOpencodeCache, _httpsGetJson, CLAUDE_TIER_LABEL, CLAUDE_ORG_LABEL,
  readClaudeCreds, claudePlanFromCreds, claudeAccountSfx, claudeAccountKey, accountLabel, apiProviderFromSettings,
};
