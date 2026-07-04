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
  claude: { label: 'Claude', comm: ['claude', 'claude-agent-acp'], adapter: 'hooks/traffic-hook.sh' },
  // gemini-cli é script Node (#!/usr/bin/env node) e NÃO seta process.title:
  // /proc/comm = "node" (verificado empiricamente) — comm vazio de propósito,
  // senão a sonda casaria com QUALQUER processo Node (falso positivo).
  // Sessões Gemini só aparecem quando houver adapter (roadmap).
  gemini:   { label: 'Gemini',   comm: [],           adapter: null },
  codex:    { label: 'Codex',    comm: ['codex'],    adapter: null }, // binário Rust
  opencode: { label: 'OpenCode', comm: ['opencode'], adapter: null }, // binário ELF (verificado)
};

const DEFAULT_AGENT = 'claude';

// Resolve o agente de uma sessão (state files v1 não têm `agent` → claude).
function agentOf(s) { return (s && AGENTS[s.agent]) ? s.agent : DEFAULT_AGENT; }

if (typeof module !== 'undefined') module.exports = { AGENTS, DEFAULT_AGENT, agentOf };
