<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# hooks/

## Purpose
Adapter de **hook de shell** — serve Claude Code, Antigravity CLI e Gemini CLI (payloads de hook quase idênticos via stdin). Roda em **TODO tool call de TODA sessão** (blast radius global), então o requisito duro é: **<25 ms, fork-free ao máximo, nunca falha**. Grava o state file canônico lido pelo overlay.

## Key Files
| File | Description |
|------|-------------|
| `traffic-hook.sh` | Hook bash. `AI_TL_AGENT` decide o agente (`claude` default \| `gemini` \| `antigravity`). Traduz dialetos → vocabulário canônico. |

## For AI Agents

### Working In This Directory
- **Filosofia (v5):** este hook **SÓ REGISTRA EVENTOS** (append-only). **NÃO** computa a cor do semáforo — isso fica no renderer (`computeState`), pois a escalada idle precisa de relógio.
- **Alvo de performance:** <25 ms. Técnicas fork-free: stdin slurpado com `read`; `session_id`/`hook_event_name` extraídos com regex bash (sem `jq` no parse); pid do agente subindo `/proc/comm` + `/proc/status` (sem `ps`, que custa ~75 ms); timestamp via `printf %(%s)T` (sem `date`); state existente lido com `$(<)` (sem `cat`). **Único fork inevitável:** `mv` (escrita atômica). Uma única chamada `jq` monta o JSON final.
- **Tradução de dialeto:** Gemini (`BeforeAgent/BeforeTool/AfterTool/AfterAgent`) e Antigravity (`PreInvocation/…`) → canônico. Eventos desconhecidos passam crus (computeState trata como verde).
- **Anti-path-traversal:** `session_id` validado (`^[A-Za-z0-9._-]+$`) antes de virar nome de arquivo; `SessionEnd` remove o state file (não vira zumbi).
- `notification_type` (evento `Notification` do Claude Code) é o discriminador entre "precisa de você" (`permission_prompt`/`idle_prompt`/`elicitation_dialog`) e benigno — o renderer classifica por este campo, nunca pela *message*.

### Testing Requirements
- `bash -n hooks/traffic-hook.sh` (syntax check do CI). Teste funcional: `npm run hook:test` (`bash hooks/traffic-hook.sh` com payload de stdin).

<!-- MANUAL: -->
