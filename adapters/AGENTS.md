<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# adapters/

## Purpose
Adapters que rodam **dentro do processo do agente** (não no overlay) e traduzem os eventos específicos de cada CLI para o **vocabulário canônico** do contrato de state file. Complementam o `hooks/traffic-hook.sh` (que cobre Claude/Antigravity/Gemini via hook de shell). Hoje: apenas OpenCode (que não tem hook de shell equivalente — usa plugin).

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `opencode/` | Plugin do OpenCode (`ai-traffic-lights.js`) — ver `opencode/AGENTS.md` |

## For AI Agents

### Working In This Directory
- O adapter escreve no **mesmo contrato** do hook bash: `${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json`, `schema_version: 2`, eventos canônicos.
- **Regra de ouro:** NUNCA quebrar o agente hospedeiro — todo handler engole exceções (`try {} catch {}`).
- Anti-path-traversal: `session_id` validado (`/^[A-Za-z0-9._-]+$/`) antes de virar nome de arquivo.

<!-- MANUAL: -->
