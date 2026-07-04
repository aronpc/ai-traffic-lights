# Changelog

All notable changes to **AI Traffic Lights** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-04

### Added
- **Quick Launcher**: start a terminal AI agent straight from the overlay/tray.
  Each detected CLI (Claude Code, Gemini CLI, Codex, OpenCode) gets a
  brand-colored **icon pill** in a persistent footer bar (and a tray "Launch"
  submenu) — on hover the agent name slides in ("✦ Claude"). A click opens the
  configured terminal in the most-recent project cwd and runs the agent; the new
  session lights up via the normal hook path (the overlay doesn't track the
  spawned process). Detection is a fork-free PATH scan (the Electron process
  sees real binaries, not shell aliases); CLIs that exist only as a shell alias
  take an override in `settings.json` (`launchers.<agent>`). The terminal is
  selectable in Preferences (Automatic / Tilix / GNOME Terminal / Ghostty /
  Custom command with `{cwd}` and `{cmd}` placeholders). Pure `src/launcher.js`
  (terminal templates + `pickTerminal`) is tested.

### Fixed
- **Window no longer resizes on its own.** After the overlay became a
  flex-column, autosize read `list.scrollHeight` — but a `flex:1` + `overflow:auto`
  element returns its flex-grown height in Chromium, so the measured value
  depended on the current window height (feedback loop → grew a few px/render).
  Now it measures the last row's natural `offsetTop`, which is independent of
  the flex height.
- **Window minimum height tracks content**: you can't drag the overlay smaller
  than its full content (header + sessions + launcher bar) — no hiding rows.

## [0.2.0] - 2026-07-04

### Fixed
- **Benign notifications no longer turn red.** The `Notification` hook event is
  now classified by its `notification_type` field (per the Claude Code hooks
  reference): `permission_prompt`, `idle_prompt` and `elicitation_dialog` stay
  🔴 (need you), while `auth_success`, `elicitation_complete` and
  `elicitation_response` resolve to 🟢 (done). The discriminator is the typed
  field, not the human-readable `message` text (which is unstable and may
  localize). The adapter captures `notification_type` into the state file;
  an unknown type falls back to red (conservative). Closes the long-standing
  "false red" UX risk.
- **Rename no longer loses focus to the terminal.** Double-clicking a label to
  rename fired two row clicks first, each raising the terminal via `wmctrl` —
  that stole keyboard focus from the input the instant it opened (it blurred
  and committed empty). A click debounce now distinguishes single-click (focus)
  from double-click (rename).

### Added
- **Version visibility**: the app version (read from `package.json` via
  `app.getVersion`) shows in the **Preferences footer** ("AI Traffic Lights
  v0.1.1") next to a clickable **GitHub** link (`shell.openExternal`, http(s)
  only), and in the **tray tooltip** ("AI Traffic Lights v0.1.1").

### Changed
- **Overlay header buttons are SVG icons** (gear / chevron / close) instead of
  text/emoji glyphs — they now align perfectly on the same axis regardless of
  font metrics (the triangle and emoji sat at different heights). The expand
  chevron rotates 180° with a smooth transition instead of swapping characters.
- **Preferences button rows use an equal-width grid** so pairs like
  "Instalar/atualizar hooks" + "Remover hooks" share the same width and height
  (no more ragged long/short look); Cancelar/Salvar are uniform too.

### Added
- **Sessions sort by urgency**: red 🔴 sessions rise to the top, then yellow 🟡,
  then green 🟢; within red, the longest-waiting first, within the others the
  most recent first. Pure `sortByUrgency()` helper in `state-machine.js`
  (tested) — the renderer applies it each render.
- **Dynamic tray icon**: the tray icon paints with the worst active color (a
  colored status dot — red/amber/green — composited on the base icon) and the
  tooltip carries the per-color counts, so the state is visible at a glance
  even with the overlay hidden. Falls back to the neutral icon when no session
  is running.
- **Per-session alert snooze**: a 🔔 button on red sessions silences the
  beep/notification for that session for 1h (the LED stays red — it only mutes
  the alert, not the state). Toggle back with 🔕.
- **In-app onboarding**: when the overlay opens with no sessions ever seen, the
  empty state shows a "Install hooks" prompt with a one-click button — the
  invisible path (tray/CLI) for AppImage users who never ran `setup-hook`.

### Added
- **UI in English & Portuguese (i18n)**: the interface follows the system
  locale (`pt*` → Portuguese, anything else → English) — overlay, tray menu,
  installer notifications and the Preferences window. The language can also be
  **switched manually in Preferences** (Automatic/English/Português, persisted
  in `settings.json`); the overlay and the tray menu re-render live on change.
  Pure `src/i18n.js` module with a key-parity test between the two languages.
- **App icon in the overlay header**, next to the "AI Lights" title (also set
  as the Preferences window icon).

### Fixed
- **Minimum sizes enforced at the WM level**: resizing by the window edge
  could shrink the overlay (now min 320 px wide) and the Preferences window
  (now min 420×600) past the point where the layout broke. The header title
  never wraps — only the counters give way (ellipsis) — and Preferences fits
  all four sections with no scrolling.
- **Preferences window stays above the overlay** (raised to the same
  always-on-top level) — it used to open behind it when the windows
  overlapped.

### Changed
- **Header counters dropped the total-sessions figure** — the per-color
  tallies (🟡 🟢 🔴) remain.

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

[Unreleased]: https://github.com/aronpc/ai-traffic-lights/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/aronpc/ai-traffic-lights/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aronpc/ai-traffic-lights/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/aronpc/ai-traffic-lights/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aronpc/ai-traffic-lights/releases/tag/v0.1.0
