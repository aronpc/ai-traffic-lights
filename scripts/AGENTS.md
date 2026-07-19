<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# scripts/

## Purpose
Scripts de setup acionados por `npm run` (ou pelo menu do tray). Hoje: instalar/remover os hooks do `traffic-hook.sh` nos `settings.json` dos agentes suportados (Claude, Antigravity, Gemini) e o plugin do OpenCode.

## Key Files
| File | Description |
|------|-------------|
| `setup-hook.js` | `npm run setup-hook` instala os hooks; `--remove` (`npm run remove-hook`) remove. Usado também pelo `src/hook-installer.js` (menu do tray). |

## For AI Agents

### Working In This Directory
- Edita `settings.json` dos agentes em `~/.claude/`, `~/.gemini/`, `~/.gemini/antigravity-cli/` e copia o plugin p/ `~/.config/opencode/plugin/`.
- Deve ser **idempotente** (rodar 2× não duplica entradas de hook) e **reversível** (`--remove` limpa tudo que instalou).
- Usado tanto por CLI quanto pela UI (`hook-installer.js`) — manter a API estável.

<!-- MANUAL: -->
