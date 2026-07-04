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
  claude: { label: 'Claude', comm: ['claude', 'claude-agent-acp'], bin: 'claude', adapter: 'hooks/traffic-hook.sh' },
  // gemini-cli é script Node (#!/usr/bin/env node) e NÃO seta process.title:
  // /proc/comm = "node" (verificado empiricamente) — comm vazio de propósito,
  // senão a sonda casaria com QUALQUER processo Node (falso positivo).
  // A sonda identifica pelo argv (basename do script em /proc/<pid>/cmdline).
  // Adapter: o MESMO traffic-hook.sh com AI_TL_AGENT=gemini (o hook traduz
  // BeforeAgent/BeforeTool/AfterTool/AfterAgent pro vocabulário canônico).
  gemini:   { label: 'Gemini',   comm: [], argv: ['gemini'], bin: 'gemini', adapter: 'hooks/traffic-hook.sh (AI_TL_AGENT=gemini)' },
  // codex-cli é Node (#!/usr/bin/env node) → comm="node" (verificado);
  // detectado pelo basename do script no argv, como o Gemini. Sem adapter
  // por enquanto — sessões aparecem como "ativo" (presença via /proc).
  codex:    { label: 'Codex',    comm: [], argv: ['codex'], bin: 'codex', adapter: null },
  // Adapter: plugin JS que roda dentro do OpenCode (instalado em
  // ~/.config/opencode/plugin/ pelo setup-hook).
  opencode: { label: 'OpenCode', comm: ['opencode'], bin: 'opencode', adapter: 'adapters/opencode/ai-traffic-lights.js' },
};

const DEFAULT_AGENT = 'claude';

// Resolve o agente de uma sessão (state files v1 não têm `agent` → claude).
function agentOf(s) { return (s && AGENTS[s.agent]) ? s.agent : DEFAULT_AGENT; }

if (typeof module !== 'undefined') module.exports = { AGENTS, DEFAULT_AGENT, agentOf };
