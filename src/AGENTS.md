<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-16 | Updated: 2026-07-16 -->

# src/

## Purpose
Renderer do overlay + **módulos de lógica pura** (testáveis sem Electron) + HTML/CSS. A regra de ouro daqui: **decisão é pura, I/O é no `main.js`**. Os testes (`test/*.test.js`) carregam estes módulos num `vm` com DOM mock.

## Key Files
| File | Description |
|------|-------------|
| `renderer.js` | Monta a lista do overlay a partir das sessões; rename in-place (dblclick); alertas na transição p/ vermelho; painel. **Choke point** `render()`. |
| `state-machine.js` | `computeState()` — **fonte da cor do semáforo** (níveis processing/done/awaiting/read + escalada idle). |
| `sessions.js` | `mergeSessions()` — dedup por `sessionKey` (origin-namespaced, ver `identity.js`); 1 processo = 1 linha. |
| `usage.js` | Coleta de consumo/quota: Claude (`~/.claude.json`), GLM (API), Codex (rollout `.jsonl`), Antigravity (SQLite). |
| `focus.js` | Lógica PURA do click-to-focus: `pickWindow`, `tabChannel` (Warp/Tilix), `parseEnviron`, `isFocusUnsupported`. |
| `agents.js` | Registro de agentes suportados (label, comm, bin, cor, argv) — canônico p/ UI + detecção. |
| `launcher.js` | Quick Launcher: como abrir cada agente em cada terminal (flags `--working-directory`, `warp://launch`). |
| `i18n.js` | `makeT(T)` + strings en/pt. |
| `settings.js` | `mergeWithDefaults()` + validação (idleThreshold, shortcut, lang, launchers…). |
| `settings-renderer.js` | Preferências: buildCfg → `pushLive()` (live-apply, grava a cada mudança). |
| `hook-installer.js` | Instala/remove hooks nos `settings.json` de cada agente. |
| `tooltip.js` · `ui-select.js` · `sound.js` · `validate.js` | Tooltips custom, dropdowns custom, alerta sonoro, validações (validSessionId/shellQuote/desktopEscape). |
| `index.html` · `styles.css` | Overlay markup + tokens/classes. `settings.html` · `settings.css` = Preferências. |
| `identity.js` | **Sync P2P** — `originOf(s)` + `sessionKey(s)` = `origin:pid\|\|session_id`; namespacing por máquina (sem colisão de pid entre nós). Browser-script + Node-require. |
| `collect.js` | **Sync P2P** — core de coleta Electron-free (state files + sonda /proc + `readSessions`/`findTranscript`/`backfillModels`). Importado pela GUI (`main.js`) e pelo `agent.js` headless. |
| `net.js` | **Sync P2P** — transporte: `startServer` (binda no IP da tailnet), `pollPeers` (backoff exponencial + gate `tailscaleOnlineSet`), `fetchTranscriptFromPeer`, `tokenOk` (constante), `detectTailnetIP`. |
| `transcript.js` | **Sync P2P** — `lastMessages(path, n)`: últimas N **mensagens** (leitura reversa em chunks, agrega `message.id`). Serve `/transcript` + o painel ver-prompt. |

## For AI Agents

### Working In This Directory
- **`computeState()` é a fonte da verdade da cor.** Hooks não decidem cor (só registram eventos); qualquer mudança de semáforo passa por aqui.
- **`render()` (`renderer.js`)** monta o DOM; enquanto um input de rename está aberto, `renaming` suspende o `render()` (não destruir o input — issue #2).
- **Maps por-sessão** (`readMarks`, `prevLevels`, `lastAlert`, `snoozed`) chaveados por `pid||session_id`; apelido por `aliasKey = session_id||pid` (v0.7.2). Limpe de chaves mortas roda a cada render.
- Modificar I/O aqui = erro. I/O (fs, `/proc`, wmctrl, IPC) é no `main.js`.

### Testing Requirements
- Cada módulo puro tem `test/<nome>.test.js`. Testes rodam os arquivos REAIS num `vm` com DOM mock — sem browser, sem deps.
- Após mexer aqui: `npm test`. Para mudar comportamento do semáforo, adicione caso em `test/state-machine.test.js`.

### Common Patterns
- Funções puras recebem dados já coletados (`focus.pickWindow(windowid, wins, ancestorPids)`), o `main.js` faz o I/O e injeta — assim a decisão é testável sem X11.
- `labelFor(s)` resolve o nome: apelido (aliasKey) → basename(cwd) → `<agente> · <pid>`.

## Dependencies
### Internal
- `main.js` instancia e faz o I/O; `preload.js` expõe a ponte consumida pelo `renderer.js`.

### External
Node core + APIs DOM do Electron (renderer). Sem libs de UI.

<!-- MANUAL: -->
