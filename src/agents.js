// agents.js — registry of monitorable AI agents (single source of truth).
// Used by main (probes /proc via `comm`) and by the renderer (per-row label).
//
// The integration contract is NOT this file — it is the STATE FILE (see README).
// A new agent joins in 2 steps: (1) an entry here; (2) an adapter that
// writes state files (Claude's is hooks/traffic-hook.sh, via native hooks).
//
// Fields:
//   label   — name shown in the UI (session row and notifications)
//   comm    — possible process names in /proc/<pid>/comm (detection of live
//             sessions without a state file yet: idle / pre-hook)
//   adapter — integrator path (informative/documentation)
const AGENTS = {
  // bin: executable name on the PATH (Quick Launcher). Detection via PATH scan;
  // CLIs that only exist as a shell alias go in the settings.launchers override.
  // mark: inline SVG (24×24) for the Quick Launcher icon. color: brand color.
  claude: { label: 'Claude', comm: ['claude', 'claude-agent-acp'], bin: 'claude', color: '#D97757',
            mark: '<path d="M12 2 L13.8 10.2 L22 12 L13.8 13.8 L12 22 L10.2 13.8 L2 12 L10.2 10.2 Z"/>',
            adapter: 'hooks/traffic-hook.sh' },
  antigravity: { label: 'Antigravity', comm: ['agy', 'antigravity'], argv: ['agy', 'antigravity'], bin: 'agy', color: '#1B73E8',
                 mark: '<path d="M12 4L4 12h5v8h6v-8h5L12 4z"/>',
                 adapter: 'hooks/traffic-hook.sh (AI_TL_AGENT=antigravity)' },
  // codex-cli is Node (#!/usr/bin/env node) → comm="node" (verified);
  // detected by the script basename in argv, like Gemini. No adapter for
  // now — sessions show up as "active" (presence via /proc).
  codex:    { label: 'Codex',    comm: [], argv: ['codex'], bin: 'codex', color: '#10A37F',
              mark: '<polyline points="9 5 17 12 9 19"/>', adapter: null },
  // Adapter: JS plugin that runs inside OpenCode (installed in
  // ~/.config/opencode/plugin/ by setup-hook).
  opencode: { label: 'OpenCode', comm: ['opencode'], bin: 'opencode', color: '#7C3AED',
              mark: '<polyline points="10 7 5 12 10 17"/><polyline points="14 7 19 12 14 17"/>',
              adapter: 'adapters/opencode/ai-traffic-lights.js' },
  // Kiro CLI — watcher adapter (adapters/kiro/ai-traffic-lights.js).
  // Main process: kiro-cli-chat (Rust/Bun). Does not expose shell hooks;
  // the adapter monitors ~/.kiro/sessions/cli/ directly.
  kiro:     { label: 'Kiro', comm: ['kiro-cli-chat', 'kiro-cli'], bin: 'kiro-cli', color: '#FF6B35',
              mark: '<path d="M12 2 L4 7 L4 17 L12 22 L20 17 L20 7 Z"/><path d="M12 8 L12 16 M8 12 L16 12" stroke="currentColor" stroke-width="1.5"/>',
              adapter: 'adapters/kiro/ai-traffic-lights.js' },
  // GLM is not a monitored CLI (it is Claude Code's BACKEND via ANTHROPIC_BASE_URL),
  // but it appears in the usage bar. Entry for the UI only (label/color/icon) — no comm/bin.
  glm:      { label: 'GLM', comm: [], bin: null, color: '#6E56CF',
              mark: '<path d="M13 2 L4 14 L11 14 L9 22 L20 9 L13 9 Z"/>' },
};

const DEFAULT_AGENT = 'claude';

// Resolves a session's agent (v1 state files have no `agent` → claude).
function agentOf(s) { return (s && AGENTS[s.agent]) ? s.agent : DEFAULT_AGENT; }

if (typeof module !== 'undefined') module.exports = { AGENTS, DEFAULT_AGENT, agentOf };
