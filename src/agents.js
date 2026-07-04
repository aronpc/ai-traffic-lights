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
  // gemini-cli é script Node (#!/usr/bin/env node) e NÃO seta process.title:
  // /proc/comm = "node" (verificado empiricamente) — comm vazio de propósito,
  // senão a sonda casaria com QUALQUER processo Node (falso positivo).
  // A sonda identifica pelo argv (basename do script em /proc/<pid>/cmdline).
  // Adapter: o MESMO traffic-hook.sh com AI_TL_AGENT=gemini (o hook traduz
  // BeforeAgent/BeforeTool/AfterTool/AfterAgent pro vocabulário canônico).
  gemini:   { label: 'Gemini',   comm: [], argv: ['gemini'], bin: 'gemini', color: '#4285F4',
              mark: '<path d="M12 3 L21 12 L12 21 L3 12 Z"/>',
              adapter: 'hooks/traffic-hook.sh (AI_TL_AGENT=gemini)' },
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
};

const DEFAULT_AGENT = 'claude';

// Resolve o agente de uma sessão (state files v1 não têm `agent` → claude).
function agentOf(s) { return (s && AGENTS[s.agent]) ? s.agent : DEFAULT_AGENT; }

if (typeof module !== 'undefined') module.exports = { AGENTS, DEFAULT_AGENT, agentOf };
