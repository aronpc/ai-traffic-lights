<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# test/

## Purpose
Suíte de testes (`node --test`, ~191 testes). Testa os **módulos puros** de `src/` carregando os arquivos REAIS num `vm` com um **DOM mock** (sem browser, sem deps) — assim a lógica do renderer/state-machine é exercitada sem Electron/X11.

## Key Files
| File | Description |
|------|-------------|
| `rename.test.js` | Rename in-place por sessão (issue #2 + regressão v0.7.2 "mesmo cwd não vaza"). |
| `state-machine.test.js` | `computeState()` — níveis, escalada idle, nível `read`. |
| `sessions.test.js` | `mergeSessions()` — dedup por `pid\|\|session_id`. |
| `focus.test.js` | `pickWindow`/`tabChannel`/`parseEnviron`/`isFocusUnsupported`. |
| `usage.test.js` | Coleta de consumo Claude/GLM/Codex/Antigravity + `mergeUsage`/`detectReset`. |
| `settings.test.js` · `i18n.test.js` · `tooltip.test.js` · `sound.test.js` · `launcher.test.js` · `validate.test.js` | Demais módulos puros. |

## For AI Agents

### Working In This Directory
- **Padrão `vm` + DOM mock** (ver `rename.test.js`): monta `window`/`document` falsos, roda `['agents.js','state-machine.js','i18n.js','renderer.js']` num `vm.createContext`, e dispara eventos (`dispatch('dblclick')`, etc.). Replicar este padrão ao adicionar testes de renderer.
- Testes de lógica pura (sessions/focus/usage/validate) só `require('../src/<mod>.js')`.
- **Comando:** `npm test` (= `node --test`). CI roda o mesmo + syntax checks.

### Testing Requirements
- Qualquer mudança de comportamento em `src/state-machine.js` ou `src/sessions.js` **deve** vir acompanhada de caso de teste aqui.
- Mantenha verde antes de commitar.

<!-- MANUAL: -->
