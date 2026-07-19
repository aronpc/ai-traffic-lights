<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# adapters/opencode/

## Purpose
Plugin do **OpenCode** do ai-traffic-lights. Instalado em `~/.config/opencode/plugin/` pelo `npm run setup-hook` (ou pelo menu do tray). Roda **dentro do processo do OpenCode** e escreve o state file canônico lido pelo overlay. Como o OpenCode pede permissão e faz perguntas por **tool/eventos** (não por um hook de shell), é aqui que o vermelho "precisa de você" dispara nesse setup.

## Key Files
| File | Description |
|------|-------------|
| `ai-traffic-lights.js` | `export const AiTrafficLights` — traduz eventos OpenCode → vocabulário canônico (tabela no cabeçalho do arquivo). |

## For AI Agents

### Working In This Directory
- **Tradução de eventos** (ver cabeçalho do arquivo): `chat.message`/message user → `UserPromptSubmit`; `tool.execute.before/after` → `PreToolUse`/`PostToolUse`; tool de pergunta (`ask`/`question`/…) → `Question` (🔴❓); `permission.ask`(hook)/`permission.asked` → `PermissionRequest` (🔴🔑); `permission.replied/updated` → `Stop`; `session.error` → `PostToolUseFailure`; `session.deleted` → remove o state file.
- **PERMISSÃO:** o OpenCode pede permissão pelo hook `permission.ask` **e** pelo evento `permission.asked` — **não** por `permission.updated` (o adapter já errava isso). Os dois caminhos são idempotentes.
- `QUESTION_TOOLS = {ask, question, ask_user_question, askuserquestion}` — frameworks autônomos (ex.: oh-my-openagent) perguntam por **tool**, então o vermelho dispara aqui, não no fluxo de permissão.
- No `UserPromptSubmit`, a janela ativa do desktop é capturada (`xdotool getactivewindow`) — é o terminal da sessão (desambigua Warp multi-janela).
- `session_id` validado (`SAFE_ID = /^[A-Za-z0-9._-]+$/`); escrita atômica `tmp`+`rename`; `events` rolante (últimos 50).

### Common Patterns
- Mesmo contrato/merge-preserve do `hooks/traffic-hook.sh` (`windowid`/`focus_url`/`tilix_id` preservam entre eventos).
- Tudo envolto em `try {} catch {}` — o plugin nunca pode derrubar o OpenCode.

<!-- MANUAL: -->
