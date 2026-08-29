<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# adapters/

## Purpose
Adapters que traduzem os eventos específicos de cada CLI para o **vocabulário canônico** do contrato de state file, complementando o `hooks/traffic-hook.sh` (que cobre Claude/Antigravity/Gemini via hook de shell).

Há **duas formas** aqui, e elas rodam em processos diferentes:

- **Plugin no processo do agente** (`opencode/`) — o agente carrega o arquivo e chama os handlers. É a forma preferida quando o agente tem API de plugin.
- **Watcher no processo do overlay** (`kiro/`) — último recurso, para agentes sem hook e sem plugin, que só deixam arquivos de sessão em disco. Custa mais caro: exceção não tratada aqui derruba o overlay inteiro (e o monitoramento de todos os outros agentes), e eventos que o agente não emite precisam ser **inferidos** — o Kiro não tem marcador de fim de turno, então o `Stop` é sintetizado a partir de um `.jsonl` quieto.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `opencode/` | Plugin do OpenCode (`ai-traffic-lights.js`) — ver `opencode/AGENTS.md` |
| `kiro/` | Watcher do Kiro (`ai-traffic-lights.js`) — roda no overlay, observa `~/.kiro/sessions/cli/` |

## For AI Agents

### Working In This Directory
- O adapter escreve no **mesmo contrato** do hook bash: `${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json`, `schema_version: 2`, eventos canônicos.
- **Regra de ouro:** NUNCA quebrar o agente hospedeiro — todo handler engole exceções (`try {} catch {}`).
- Anti-path-traversal: `session_id` validado antes de virar nome de arquivo. Use o `validSessionId()` de `src/validate.js` quando o adapter rodar no overlay (é testado); o plugin do OpenCode carrega a própria cópia porque roda fora da app e não alcança esse módulo.
- **Preserve, don't regress:** ao reescrever um state file, faça merge do que já está lá — `transcript_path`, campos de foco e chaves de terceiros não podem ser apagados por um evento que não os carrega.

<!-- MANUAL: -->
