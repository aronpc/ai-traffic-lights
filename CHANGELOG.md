# Changelog

All notable changes to **AI Traffic Lights** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
### Changed
### Fixed

## [0.5.0] - 2026-07-08

### Added
- **Self-update from the UI (AppImage).** The overlay now checks for new
  releases periodically (on launch + every 1h) and, for AppImage installs,
  downloads and applies the update in place — a `↓ vX` button downloads with a
  live progress %, then a `↻ vX` button restarts into the new version. Wired
  via `electron-updater` with `publish` set to GitHub. `.deb` / `npm` / `source`
  installs keep the existing "open the release in the browser" flow, since
  `electron-updater` only auto-updates AppImage on Linux. A **"Check for
  updates"** tray item (and clicking the version in the header) runs an on-demand
  check that also posts a desktop notification with the result (new version / up
  to date / error). (Requires future releases to ship `dist/latest.yml` + the
  `.AppImage` as release assets.)

### Changed
- **Reset clock now reads as a countdown.** The footer's quota-reset indicator
  shows `Xmin` under 1h, `HH:MM` within 24h (the wall-clock reset time), and
  `Xd` beyond — instead of the old `HH:MM` / `1d HHh` / `Nd`, which buried the
  "resetting soon" case behind an absolute clock.
- **Bumped Electron 31 → 43** (devDependency).
- **Resize grip now rounds with the window corner.** The bottom-right resize
  handle was a sharp square `L`; it's now a curved arc that echoes the panel's
  `border-radius`, so it reads as part of the rounded corner.

### Fixed
- **Overlay window no longer opens off-screen after a display change.** A saved
  position could land outside the active work area when an external monitor was
  disconnected and the layout shrank, leaving the overlay invisible or
  repositioned by the WM. `createWindow` now clamps any persisted bounds back
  to the primary display's corner when they fall outside all known displays.
- **Renderer crash on `/dev/shm` under Ubuntu 24.04 (companion to v0.4.1).**
  Even with `--no-sandbox`, the packaged app still couldn't allocate shared
  memory on this host: Chromium's default `/dev/shm` path failed with `ESRCH`,
  so only the tray opened and no window drew. `main.js` now also passes
  `--disable-dev-shm-usage` so Chromium falls back to `/tmp`.
- **Antigravity quota no longer false-triggers.** The conversation-DB scan that
  detects an exhausted quota matched too broadly: support chats about the very
  quota code (mentioning `debug_usage.js` / `traffic-hook.sh`) and stale DBs
  from a previous plan produced phantom "exhausted" states. The parser now
  (a) skips DBs modified more than 2h ago, (b) requires
  `"reason":"QUOTA_EXHAUSTED"` within ~250 chars of the reset timestamp
  instead of a loose `QUOTA_EXHAUSTED …` prefix, and (c) ignores DBs that
  mention the project's own debug/hook files. A fresh `antigravity-plan` entry
  also clears a stale `antigravity-quota` from the merged cache.
- **Usage paths resolve `home` via `os.homedir()` instead of `process.env.HOME`.**
  `HOME` can be unset or wrong in some sandboxed launch contexts, which made
  the passive adapters (Claude, Antigravity, Codex) miss their config files.
  `collectUsage` now receives the home dir explicitly and each reader falls
  back to `os.homedir()`.


## [0.4.1] - 2026-07-08

### Fixed
- **App now launches on Ubuntu 24.04+ when packaged (`.deb` / AppImage).** The
  bundled Chromium sandbox couldn't create a user namespace under Ubuntu's
  `apparmor_restrict_unprivileged_userns=1`, so every shared-memory allocation
  aborted with `platform_shared_memory_region_posix … No such process` and the
  overlay never opened. Both Linux targets now pass `--no-sandbox` via
  `linux.executableArgs`, so the `.desktop` / AppRun `Exec` carries the flag —
  matching what `npm start` and the generated autostart entry already do.
  (`app.commandLine.appendSwitch('no-sandbox')` in `main.js` is not enough: the
  sandbox initializes before the main script runs, so the switch must be on the
  command line.)


## [0.4.0] - 2026-07-07

### Changed
- **Preferences redesigned** to match the overlay's custom chrome and apply
  live. The window is now frameless/transparent with the same rounded panel,
  drag header, and ✕ as the overlay, organized into two tabs (Geral ·
  Integração). Every control applies **instantly** to the overlay as you edit
  (no Save/Cancel — just Fechar), and the transparency slider now dims the
  Preferences window itself too. The window is a fixed, non-resizable size.

### Removed
- **Preferences trim.** Dropped the "Sobre" tab (version + GitHub link moved
  to the footer), the "Janela" section (show/hide + quit already live in the
  tray), and the "compact list" toggle (already on the overlay header). Eight
  now-unused i18n strings were removed with them.

### Fixed
- **OpenCode permission prompts now turn the light red.** The plugin listened
  for `permission.updated`, which doesn't fire when OpenCode asks — it uses the
  `permission.ask` hook and the `permission.asked` event. The adapter now hooks
  both (→ 🔴🔑) and clears on `permission.replied` (→ Stop). Reinstall with
  `npm run setup-hook` (or the tray) to pick it up.
- **Preferences: partial config no longer wipes custom launcher paths.** The
  Preferences window sends only its own keys, but `persistSettings` rebuilt
  from the defaults — so every save reset `showUsage` / `collapsed` /
  `launchers`, wiping custom launcher overrides and flipping the footer. It
  now merges over the current settings.
- **Preferences window fits small displays.** It's fixed and non-resizable
  (761px), so on a 1366×768 screen it didn't fit and the footer Fechar button
  landed off-screen with no way to reach it. The height is now clamped to the
  display's work area (multi-monitor aware); the body scrolls, so the header,
  tabs and Fechar always stay visible.

### Added
- **OpenCode usage %.** When OpenCode is configured with the z.ai
  (`zai-coding-plan`) provider, its API key from `~/.local/share/opencode/auth.json`
  queries the same quota endpoint as GLM, so its plan % shows in the footer.
  Deduped by token — the same z.ai account open in a terminal and in OpenCode
  collapses to one row.
- **Mark a red terminal as read.** Clicking a 🔴 session now both focuses its
  terminal and marks it read — the light goes grey (⚪) and stops nagging until
  a *new* notification arrives (a red event newer than the moment you clicked
  re-lights it). On by default; toggle in Preferences → Behavior
  (`settings.markReadOnClick`). Amber/green are never affected; the read state
  is per live session (a restart brings the red back).
- **Architecture docs.** New [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) with
  Mermaid diagrams (integration flow · state-file lifecycle · event→color ·
  session discovery), the full state-file schema, and a step-by-step guide to
  adding a new agent/IDE — linked from the README.
- **Per-agent usage footer — a meter panel.** The footer shows one row per
  usage window as an aligned meter (CSS-grid shared columns, so every track is
  identical and the reset column keeps equal space): agent icon · name · big %
  reading · gradient meter with a lit leading-edge cap · reset time. Rows go
  green / amber (≥70%) / red (≥90%); the red meter's cap pulses. A repeated
  plan name is shown once (first row `Plan · window`, later rows just the
  window). Reset shows `HH:MM` today, `1d HH` tomorrow, `Nd` further out.
  - **Claude** now shows **real % and reset** for the 5-hour and 7-day windows,
    fetched from `api.anthropic.com/api/oauth/usage` with the OAuth token in
    `~/.claude/.credentials.json` (`anthropic-beta: oauth-2025-04-20`) — the
    same numbers as `/status`. Falls back to a plan-only row (no %) if the
    token is missing/expired.
  - **GLM Coding Plan** shows 5-hour token % and monthly MCP % via
    `/api/monitor/usage/quota/limit` (real per-window `nextResetTime`).
    Credentials are read **per terminal, per account** from the
    `/proc/<pid>/environ` of every live GLM session, deduped by token — distinct
    z.ai accounts each get their own labelled block with their own %, the same
    account across terminals collapses to one. No token on disk, no global env.
  - **Codex** (ChatGPT plan) shows real 5-hour and 7-day % + reset, read
    **passively** from the session's rollout (`~/.codex/sessions/**/rollout-*.jsonl`,
    last `token_count` event → `rate_limits`). No network — matched to the live
    session by cwd (`/proc/<pid>/cwd`).
  - **Antigravity** (Gemini CLI) shows `Antigravity (<model>)` read passively
    from `~/.gemini/antigravity-cli/settings.json`. Google doesn't expose a
    running usage %, but when a model's quota is **exhausted** the conversation
    DBs record the API's `QUOTA_EXHAUSTED` error with its weekly reset time — so
    an exhausted model shows a full red bar (100%) and the reset countdown;
    otherwise it's the label alone.
    New `src/usage.js` (pure parsers + I/O, unit tested); collectors run on a
    60s cadence decoupled from the 5s session loop; responses cached 30s and
    never throw.
  - **Last value sticks — no more flicker to zero.** When a collector misses a
    tick (network blip, session not yet ready), each row keeps its last good
    value instead of blanking. After ~4 min without a fresh value the row dims
    to grey (marked stale, number still shown); after ~20 min it drops. A new
    good value resets the clock. (`usage.mergeUsage`, merged per row id.)
  - **Usage survives restarts.** The last known values are saved to `usage.json`
    and reloaded on launch, so the footer isn't blank for the first minute after
    reopening. Reloaded rows come back **grey (stale)** until a fresh value
    arrives — never shown as if current — and anything older than ~20 min is
    dropped. No tokens are written; the file holds only plan/%/reset.
- **Appearance preferences.** A new *Appearance* section in Preferences adds
  two knobs, applied live (no restart) and persisted:
  - **Window transparency** — a slider (60–100%) sets how opaque the panel is,
    driving the overlay's background alpha (`settings.opacity`, default 0.97).
  - **Compact list** — a one-line-per-session mode: fixed columns that align
    across rows (`status light · reason icon · agent icon · name — model · tool
    · time`), the agent's coloured icon standing beside its name, all on a
    single tight line (`settings.compact`, default off). A header button toggles
    it too.
- **Session rows redesigned.** Every row now carries the agent's coloured
  LLM/CLI icon in its own aligned column, and the alert-bell column is always
  reserved — showing or hiding the bell no longer nudges the row's size. The
  window's minimum width grew to keep every header button (list · footer ·
  preferences · expand · close) visible.
- **UI state persists across restarts.** The footer mode (`showUsage`) and the
  collapsed/expanded window state (`collapsed`) are saved to `settings.json` and
  restored on launch — no Preferences UI, just remembered. Toggling the footer
  or collapsing the window while collapsed now also re-fits the window height so
  no empty space is left behind.
- **Custom animated tooltips.** The native OS `title` tooltips (slow, unstyled)
  are replaced by a styled bubble that matches the overlay: dark gradient,
  arrow, fade + slide + scale on show, ~380ms delay, keyboard-focus support.
  A single delegated handler covers the header, usage rows and launcher. The
  bubble is positioned inside the window (clamped to the viewport, flips above
  the target when there's no room below, arrow re-aims at the target center).
  New `src/tooltip.js` (pure `tipPosition` + event wiring, unit tested).
- **Version + update check in the header.** Left of the gear, the header shows
  the app version (`vX.Y.Z`). When a newer GitHub release exists it becomes a
  green clickable "↑ vX.Y.Z" badge that opens the release page; the install
  method (`deb` / `AppImage` / `npm` / `source`) is auto-detected and shown in
  the tooltip. Checked against
  `api.github.com/repos/aronpc/ai-traffic-lights/releases/latest` with a 30-min
  cache; offline is silent (no badge).

### Fixed
- **Click-to-focus on GNOME Terminal (Wayland) no longer fails silently.**
  GNOME Terminal runs as a native Wayland window that `wmctrl` can't see, and
  unlike Warp/Tilix it exports no focus hint (`WARP_FOCUS_URL`/`TILIX_ID`) — so
  clicking its session was a silent no-op (the terminal never came forward). The
  overlay now detects the no-op (Wayland + no window raised + no tab channel)
  and shows a notification explaining the terminal isn't reachable, suggesting
  Tilix or running under X11/XWayland. X11/XWayland behavior is unchanged.
  (`focus.isFocusUnsupported`, pure + unit tested.)
- **Usage footer no longer shows redundant/duplicate tiles.** When a collector
  briefly failed mid-tick (network blip), its fallback "summary" row
  (plan-only Claude, or GLM without parsed limits) could coexist with the real
  meter rows from the previous good tick — e.g. "Claude Max" beside
  "Claude Max 5× - 5 h", or "GLM" beside "GLM Pro - MCP (mês)". A summary row
  is now suppressed whenever a concrete meter of the same agent is present
  (fresh or held over from the previous tick). (`usage.mergeUsage`,
  regression-tested; surfaced by a user report.)

## [0.3.2] - 2026-07-05

### Fixed
- **Collapsed overlay now keeps the launcher footer.** Hiding the footer
  along with the list left only the header (58px) on collapse. Expected
  behaviour: collapse hides the list and resizes to header + footer
  (~103px), keeping the Quick Launcher visible. `setExpanded()` now leaves
  the launcher bar on and asks the main process for header+footer height
  (new `h` arg on the `set-expanded` IPC, plumbed through preload).
- **Window reliably shrinks on collapse.** `setSize()` below the current
  `minimumSize` is silently rejected by GNOME/X11 — `getBounds()` returns
  the old height with no error. `setMinimumSize()` is now called BEFORE
  `setSize()` in both the `set-expanded` and `auto-height` handlers, so the
  window can actually shrink (also fixes `auto-height` shrinking after a
  grow).

## [0.3.1] - 2026-07-04

### Fixed
- **Empty state no longer grows the window on its own.** The 0.3.0 autosize fix
  covered the session-rows path, but the onboarding/empty state still had the
  feedback loop: `setExpanded(true)` unhid the (empty) `flex:1` list, which
  flex-grew and pushed `.empty` down, so `$empty.offsetTop` depended on the
  current window height (window crawled a few px every 2s render tick). The
  list is now hidden whenever there are no sessions, making the empty-state
  measurement natural again.
- **Hidden launcher bar actually hides.** `.launcher-bar { display:flex }`
  overrode the UA `[hidden] { display:none }` rule, so with zero detected CLIs
  the "hidden" bar still rendered an empty strip (border + padding) that
  autosize didn't account for.

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

[Unreleased]: https://github.com/aronpc/ai-traffic-lights/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/aronpc/ai-traffic-lights/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/aronpc/ai-traffic-lights/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aronpc/ai-traffic-lights/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/aronpc/ai-traffic-lights/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aronpc/ai-traffic-lights/releases/tag/v0.1.0
