<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# ai-traffic-lights

## Purpose
Overlay de desktop (Electron) com um semáforo 🟢🟡🔴 **por sessão** de agente de IA (Claude Code, Antigravity, Codex, OpenCode, Gemini/GLM). Monitora sessões via **hooks** que gravam *state files* + uma sonda de `/proc` (Linux) / `ps`+`osascript` (macOS), e mostra status, consumo e reset num overlay always-on-top. O design é *dependency-light* (Electron + `http` nativo; hook em bash).

## Key Files
| File | Description |
|------|-------------|
| `main.js` | Processo **main** do Electron: coleta (state files + `/proc`), IPC, tray, settings, uso, foco de aba, auto-update. Ponto quente do repo. |
| `preload.js` | Ponte `contextBridge` (`window.trafficLight.*`) entre renderer e main. |
| `package.json` | Manifesto + `electron-builder` (`build.publish`=GitHub). Scripts: `start` (`electron . --no-sandbox …`), `test` (`node --test`), `dist`. |
| `install.sh` / `install_macos.sh` | Instaladores CLI (instalam o app + hooks nos settings dos agentes). |
| `CHANGELOG.md` | Keep a Changelog (PT-BR); release notes saem daqui. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Renderer + lógica pura + HTML/CSS (ver `src/AGENTS.md`) |
| `adapters/` | Adapter de plugin do OpenCode (ver `adapters/AGENTS.md`) |
| `hooks/` | Hook bash p/ Claude/Antigravity/Gemini (ver `hooks/AGENTS.md`) |
| `test/` | Suíte `node --test` (ver `test/AGENTS.md`) |
| `scripts/` | Instalador de hook via npm (ver `scripts/AGENTS.md`) |
| `docs/` | `ARCHITECTURE.md` (ver `docs/AGENTS.md`) |

## For AI Agents

### Contrato central — ENTENDER ANTES DE MEXER
- **State files** em `${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json`, `schema_version: 2`.
- **Vocabulário canônico de eventos** (`last_event`): `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, `Question` (🔴❓), `PermissionRequest` (🔴🔑), `PostToolUseFailure` (🔴⚠). O evento `Notification` do Claude Code é classificado pelo campo `notification_type` (nunca pela *message*, que é i18n-instável).
- **Separação de camadas:** hooks/adapters **só registram eventos** (append-only); a **cor do semáforo** é decidida no renderer (`src/state-machine.js` `computeState`), porque a escalada idle (verde→vermelho após N min) exige relógio.
- **Anti-path-traversal:** `session_id` validado contra `^[A-Za-z0-9._-]+$` em **todo** writer (hook bash + adapter opencode).
- **Dedup:** chave `pid || session_id` = 1 processo = 1 terminal = 1 linha (`src/sessions.js`). Apelido (rename) é por sessão: `aliasKey = session_id || pid` (v0.7.2).

### Working In This Directory
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` são **gitignored** (docs locais de IA — não commitam).
- Este repo recebe commits de **sessões paralelas**. ANTES de commitar: conferir `git log origin/main..HEAD` e `git diff --cached` (já houve clobber por `git add -A` de outra sessão varrendo trabalho não-commitado).
- **Release é manual** (o CI só testa). Fluxo completo e convenção em `.omc/RELEASE_RULE.md`.

### Testing Requirements
- `npm test` (= `node --test`, ~191 testes). Sempre verde antes de commitar.
- CI (`.github/workflows/ci.yml`): syntax checks (`bash -n hooks/*.sh`, `node --check main.js preload.js src/*.js scripts/*.js`) + `npm test`.

### Common Patterns
- **Módulos puros testáveis sem Electron** em `src/` (sessions, state-machine, focus, usage, validate) — todo I/O fica no `main.js`, a decisão é injetável/testável.
- **Escrita atômica** `tmp` + `rename` (race-safe contra o hook).
- Environments lidos de `/proc/<pid>/environ` (`focus.parseEnviron`) para hints de foco (`WARP_FOCUS_URL`, `TILIX_ID`).

## Dependencies
### External
Electron · electron-builder · electron-updater · `jq` (hook bash). Sem framework de UI — renderer é JS + HTML/CSS nativos.

<!-- MANUAL: -->
