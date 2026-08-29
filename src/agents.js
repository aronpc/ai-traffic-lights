// agents.js — registro de agentes de IA monitoráveis (fonte única de verdade).
// Usado pelo main (sonda /proc via `comm`) e pelo renderer (label por linha).
//
// O contrato de integração NÃO é este arquivo — é o STATE FILE (ver README).
// Um agente novo entra em 2 passos: (1) uma entrada aqui; (2) um adapter que
// escreva state files (o do Claude é hooks/traffic-hook.sh, via hooks nativos).
//
// Campos:
//   label   — nome exibido na UI (linha da sessão e notificações)
//   comm    — nomes de processo possíveis em /proc/<pid>/comm (detecção de
//             sessões vivas ainda sem state file: idle / pré-hook)
//   adapter — caminho do integrador (informativo/documentação)
const AGENTS = {
  // bin: nome do executável no PATH (Quick Launcher). Detecção por PATH scan;
  // CLIs que só existem como alias de shell vão no override settings.launchers.
  // mark: SVG interno (24×24) do ícone do Quick Launcher. color: cor da marca.
  claude: { label: 'Claude', comm: ['claude', 'claude-agent-acp'], bin: 'claude', color: '#D97757',
            mark: '<path d="M12 2 L13.8 10.2 L22 12 L13.8 13.8 L12 22 L10.2 13.8 L2 12 L10.2 10.2 Z"/>',
            adapter: 'hooks/traffic-hook.sh' },
  antigravity: { label: 'Antigravity', comm: ['agy', 'antigravity'], argv: ['agy', 'antigravity'], bin: 'agy', color: '#1B73E8',
                 mark: '<path d="M12 4L4 12h5v8h6v-8h5L12 4z"/>',
                 adapter: 'hooks/traffic-hook.sh (AI_TL_AGENT=antigravity)' },
  // codex-cli é Node (#!/usr/bin/env node) → comm="node" (verificado);
  // detectado pelo basename do script no argv, como o Gemini. Sem adapter
  // por enquanto — sessões aparecem como "ativo" (presença via /proc).
  codex:    { label: 'Codex',    comm: [], argv: ['codex'], bin: 'codex', color: '#10A37F',
              mark: '<polyline points="9 5 17 12 9 19"/>', adapter: null },
  // Adapter: plugin JS que roda dentro do OpenCode (instalado em
  // ~/.config/opencode/plugin/ pelo setup-hook).
  opencode: { label: 'OpenCode', comm: ['opencode'], bin: 'opencode', color: '#7C3AED',
              mark: '<polyline points="10 7 5 12 10 17"/><polyline points="14 7 19 12 14 17"/>',
              adapter: 'adapters/opencode/ai-traffic-lights.js' },
  // Kiro CLI — adapter de watcher (adapters/kiro/ai-traffic-lights.js).
  // Processo principal: kiro-cli-chat (Rust/Bun). Não expõe hooks de shell;
  // o adapter monitora ~/.kiro/sessions/cli/ diretamente.
  kiro:     { label: 'Kiro', comm: ['kiro-cli-chat', 'kiro-cli'], bin: 'kiro-cli', color: '#FF6B35',
              mark: '<path d="M12 2 L4 7 L4 17 L12 22 L20 17 L20 7 Z"/><path d="M12 8 L12 16 M8 12 L16 12" stroke="currentColor" stroke-width="1.5"/>',
              adapter: 'adapters/kiro/ai-traffic-lights.js' },
  // GLM não é um CLI monitorado (é o BACKEND do Claude Code via ANTHROPIC_BASE_URL),
  // mas aparece na faixa de uso. Entrada só pra UI (label/cor/ícone) — sem comm/bin.
  glm:      { label: 'GLM', comm: [], bin: null, color: '#6E56CF',
              mark: '<path d="M13 2 L4 14 L11 14 L9 22 L20 9 L13 9 Z"/>' },
};

const DEFAULT_AGENT = 'claude';

// Resolve o agente de uma sessão (state files v1 não têm `agent` → claude).
function agentOf(s) { return (s && AGENTS[s.agent]) ? s.agent : DEFAULT_AGENT; }

if (typeof module !== 'undefined') module.exports = { AGENTS, DEFAULT_AGENT, agentOf };
