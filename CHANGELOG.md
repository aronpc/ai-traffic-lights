# Changelog

All notable changes to **AI Traffic Lights** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-04

### Security
- **Path traversal hardened**: session ids from hook payloads are validated
  (`[A-Za-z0-9._-]`) before becoming file paths — a malicious `../` payload
  can no longer write/delete outside the state dir. Applied to the bash hook
  and the OpenCode plugin. ([#13](https://github.com/aronpc/ai-traffic-lights/pull/13))
- **Hook commands are shell-quoted** (e.g. `bash '/.../traffic-hook.sh'`) so a
  `HOME`/`XDG_DATA_HOME` with spaces or shell metacharacters can't break or
  redirect the registered hook command. ([#13](https://github.com/aronpc/ai-traffic-lights/pull/13))
- **Autostart `.desktop` Exec escapes** `process.execPath` and the app dir per
  the Desktop Entry spec — a HOME/project path with spaces no longer breaks
  the autostart command. ([#13](https://github.com/aronpc/ai-traffic-lights/pull/13))

### Added
- **Preferences window mirrors the tray**: autostart toggle, install/remove
  hooks, show/hide overlay, and quit are now all available from the gear icon
  → Preferences (not only the tray menu). New "Inicialização", "Integração"
  and "Janela" sections. ([#14](https://github.com/aronpc/ai-traffic-lights/pull/14))
- **Codex support**: adapter via `~/.codex/hooks.json` (Codex shares Claude's
  hooks schema, so the same `traffic-hook.sh` runs with `AI_TL_AGENT=codex` —
  no event translation). Model is read straight from the payload. After
  `setup-hook`, run `/hooks` in the Codex CLI once to trust the hook. ([#12](https://github.com/aronpc/ai-traffic-lights/pull/12))
- **Gemini CLI support**: adapter via hooks (`AI_TL_AGENT=gemini`), translating
  `BeforeAgent`/`BeforeTool`/`AfterTool`/`AfterAgent` into the canonical event
  vocabulary. Idle Gemini sessions detected by the script basename in the
  process argv (its `comm` is `node`). ([613c042](https://github.com/aronpc/ai-traffic-lights/commit/613c042))
- **OpenCode support**: adapter as an in-process plugin
  (`adapters/opencode/ai-traffic-lights.js`) capturing model, cwd and terminal
  identity. ([c1e26ab](https://github.com/aronpc/ai-traffic-lights/commit/c1e26ab))
- **Configurable idle threshold & global shortcut** via tray → Preferences
  (and the **⚙** button in the overlay header). Stored in `settings.json`;
  the Preferences window remembers its own position and size. ([#10](https://github.com/aronpc/ai-traffic-lights/pull/10))
- **Wayland graceful degradation**: the terminal focus URI goes first there
  (wmctrl only sees XWayland); relaunching the app toggles the overlay
  (single-instance) — a Wayland-friendly shortcut path. ([4ab3353](https://github.com/aronpc/ai-traffic-lights/commit/4ab3353))
- **Test suite** (`node:test`, no dependencies) for the pure modules
  (state machine, focus, sessions, settings, validate) plus a renderer
  regression harness. **CI** on every push/PR. ([#4](https://github.com/aronpc/ai-traffic-lights/pull/4))
- **Refreshed screenshots & demo GIF**: README hero is now an animated GIF
  (red LED pulse) plus a static shot of all four agents (Claude, Gemini, Codex,
  OpenCode) across every state, and a Preferences-window screenshot — captured
  window-only at 2× from mocked state files. ([#15](https://github.com/aronpc/ai-traffic-lights/pull/15))

### Fixed
- **No alert on startup**: a session that is already red when the app opens no
  longer fires a beep/notification — only real green→red transitions do. ([#13](https://github.com/aronpc/ai-traffic-lights/pull/13))
- **`set-alias` IPC validates** its payload (string `cwd`/`alias`, sane
  lengths) instead of persisting malformed keys. ([#13](https://github.com/aronpc/ai-traffic-lights/pull/13))
- **Duplicate `quit` IPC handler** removed — it was registered twice after the
  Preferences mirror landed (#14).
- **`backfillModels()` writes atomically** (tmp + rename) like every other
  state-dir writer — the last remaining in-place write could race the hook.
- **Model extraction** tolerates pretty-printed transcripts — Gemini writes
  `"model": "x"` (with a space); Claude uses compact JSONL. ([2f61096](https://github.com/aronpc/ai-traffic-lights/commit/2f61096))
- **Rename in-place** no longer destroyed by re-renders while typing. ([#3](https://github.com/aronpc/ai-traffic-lights/pull/3), closes [#2](https://github.com/aronpc/ai-traffic-lights/issues/2))
- **Click-to-focus** is reliable: the stored window id is validated against
  the session's process tree (a recycled id never focuses the wrong window),
  and the exact **tab** is reached in Warp (`warp://session/<uuid>`) and
  Tilix (`TILIX_ID` via D-Bus). ([#5](https://github.com/aronpc/ai-traffic-lights/pull/5), closes [#1](https://github.com/aronpc/ai-traffic-lights/issues/1))
- **Tilix sessions** no longer vanish from the overlay (the `term_program`
  filter wrongly hid them — Tilix doesn't export `TERM_PROGRAM`). ([#7](https://github.com/aronpc/ai-traffic-lights/pull/7), closes [#6](https://github.com/aronpc/ai-traffic-lights/issues/6))
- **Window is movable again** — `type: 'toolbar'` had made Mutter drop
  `_NET_WM_ACTION_MOVE`. The skip-taskbar state is now forced via `wmctrl`
  instead, keeping the alt-tab exclusion without sacrificing drag. ([#9](https://github.com/aronpc/ai-traffic-lights/pull/9), closes [#8](https://github.com/aronpc/ai-traffic-lights/issues/8))

### Changed
- **Docs**: README screenshots now render at a fixed, smaller display width
  (the raw 2× captures were shown full-size); `overlay.png` re-encoded
  16-bit → 8-bit (502 KB → 152 KB, visually identical); the Requirements
  section lists all four supported agents.

## [0.1.0] - 2026-07-04

### Added
- Initial public release. Translucent always-on-top overlay showing every
  terminal AI agent session as a traffic light (🟢 done · 🟡 working · 🔴
  needs you). Claude Code adapter via hooks; agent-agnostic state-file
  contract.
- Click-to-focus, idle escalation, alerts (beep + notification), per-project
  aliases, tray, global shortcut, autostart.
- Bilingual docs (EN / pt-BR), `setup-hook` installer with a stable hook copy
  (AppImage-safe, move-safe), AppImage + `.deb` packaging.

[Unreleased]: https://github.com/aronpc/ai-traffic-lights/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/aronpc/ai-traffic-lights/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aronpc/ai-traffic-lights/releases/tag/v0.1.0
