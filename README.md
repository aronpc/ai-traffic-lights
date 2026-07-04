# 🚦 AI Traffic Lights

**English** | [Português (Brasil)](README.pt-BR.md)

[![CI](https://github.com/aronpc/ai-traffic-lights/actions/workflows/ci.yml/badge.svg)](https://github.com/aronpc/ai-traffic-lights/actions/workflows/ci.yml)

A translucent always-on-top overlay (Electron) that shows the state of every
**terminal AI agent session** on your desktop as a traffic light: 🟢 done ·
🟡 working · 🔴 needs you.

Monitors **Claude Code**, **Gemini CLI**, **Codex** and **OpenCode** today. The
architecture is agent-agnostic — new agents land via adapters (see
[Adding an agent](#adding-a-new-agent)).

<p align="center"><img src="assets/screenshots/overlay-pulse.gif" alt="AI Traffic Lights — live overlay" width="340"></p>

_One light per terminal AI session: 🟢 done · 🟡 working · 🔴 needs you. Animated:
the red LED pulses. Static shot below._

<p align="center"><img src="assets/screenshots/overlay.png" alt="AI Traffic Lights overlay — all agents" width="340"></p>

## Why

When you run several AI agent sessions in parallel across terminals, tabs and
projects, you lose track of which one finished, which is still crunching, and
which has been silently waiting for your approval for ten minutes. This
overlay gives you one glance: a light per session, click to jump to its
terminal — **window _and_ tab**.

## Features

- 🟢🟡🔴 One light per session, plus an aggregate light in the header
- 🤖 **Four agents, one overlay**: Claude Code, Gemini CLI, Codex and OpenCode
- 🌐 UI in English & Portuguese — follows the system locale, switchable in
  Preferences
- **Click-to-focus**: jumps to the session's terminal — the exact window, and
  in Warp the exact **tab** (via `warp://session/<uuid>`) and in Tilix the
  exact terminal (via D-Bus `TILIX_ID`)
- 🔔 Beep + desktop notification when a session turns red (rate-limited)
- ⏰ Idle escalation: a finished session left unattended turns red (configurable)
- 🔔 Per-session **alert snooze** (mute the beep for 1h on a red session)
- 🔝 Sessions **sort by urgency** (red → yellow → green); **dynamic tray icon**
  paints with the worst color and shows counts on hover
- ✏️ Double-click to rename a session (aliases persist per project)
- ⚙️ **Preferences window** (gear icon): idle threshold, global shortcut,
  autostart, install/remove hooks, show/hide, quit
- Auto-height, drag anywhere, width-resizable, position persisted
- Tray icon + global shortcut **`Ctrl+Alt+H`** (configurable)
- Stays out of your way: no taskbar/alt-tab entry, never maximizes, no scrollbar

<p align="center"><img src="assets/screenshots/preferences.png" alt="Preferences window" width="400"></p>

## Requirements

- **Linux**. X11: full support (GNOME/Mutter tested). **Wayland: partial** —
  the overlay runs via XWayland; tab-focus works in Warp (`focus_url`);
  window focus reaches XWayland terminals only. See Troubleshooting.
- `wmctrl`, `xdotool`, `jq` — `sudo apt install wmctrl xdotool jq`
- Node.js 20+
- A supported agent: [Claude Code](https://claude.com/claude-code),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli),
  [Codex](https://github.com/openai/codex) or [OpenCode](https://opencode.ai)

## Install (from source)

```bash
git clone https://github.com/aronpc/ai-traffic-lights.git
cd ai-traffic-lights
npm install
npm run setup-hook   # registers the adapters: Claude Code (~/.claude),
                     # Gemini CLI (~/.gemini) and OpenCode (plugin in
                     # ~/.config/opencode/plugin/), whichever are present
npm start            # opens the overlay
```

`setup-hook` is idempotent and surgical: it backs up `settings.json` and never
touches hooks from other tools. The registered command points to a
self-updating **stable copy** of the hook in
`~/.local/share/ai-traffic-lights/bin/` — so moving the project (or running
the packaged AppImage, whose mount path changes every run) never breaks it.
`npm run remove-hook` undoes everything just as cleanly. The tray menu offers
the same install/remove actions for packaged installs.

New Claude Code sessions show up immediately; sessions already open appear on
their next event.

## How it works

```
Claude Code session ──hooks──▶ traffic-hook.sh (adapter, <25ms, fork-free)
                                      │ writes
                                      ▼
                    ~/.local/share/ai-traffic-lights/state/<session>.json
                                      │ watched (chokidar)
                                      ▼
                    Electron main ──IPC──▶ renderer: computeState() → 🟢🟡🔴
```

> **Architecture decision:** the adapter only records events. The **state
> (color) is computed in the renderer**, because idle escalation
> (green→red after N minutes) needs a clock — something an event-driven hook
> doesn't have.

> **The integration contract is the state file, not the code.** Anything that
> writes a valid JSON into the state dir becomes a light in the overlay.

### State file contract (schema_version 2)

**Location:** `${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json`

```jsonc
{
  "schema_version": 2,           // bump when the schema changes
  "agent": "claude",             // agent id (key in src/agents.js)
  "session_id": "abc-123",       // key, = file name
  "pid": 986893,                 // agent process PID (dead-session sweep)
  "cwd": "/home/user/project",   // project dir (basename = default label)
  "term_program": "WarpTerminal",// source terminal (null if unknown)
  "windowid": "67108868",        // X11 window of the session — see below
  "focus_url": "warp://session/8726…", // Warp: focus URI (xdg-open)
  "tilix_id": null,              // Tilix: terminal id for activate-terminal (D-Bus)
  "zellij_session": null,        // zellij session name, when inside zellij
  "last_event": "Stop",          // last hook_event_name
  "last_event_ts": 1783124001,   // epoch of the last event (UTC)
  "last_tool": "Bash",           // last tool_name (null for tool-less events)
  "events": [                    // rolling log (last 50), append-only
    { "ts": 1783124000, "event": "PostToolUse", "tool": "Bash" },
    { "ts": 1783124001, "event": "Stop",        "tool": null }
  ]
}
```

**Types:** every `*_ts` is an integer epoch. `windowid` is a **string**
(xdotool decimal or `0x…` hex; the app normalizes). `pid` is an integer.

### Focusing the right window — and the right tab

**Window** (`windowid`): captured at `UserPromptSubmit`/`SessionStart` (the
focused window then **is** the session's terminal) via `xdotool
getactivewindow`, preserved across events. Before using it, `focusSession()`
**validates** it against the session's process tree — a stale or recycled id
whose window no longer belongs to the session is discarded (so a click never
focuses the wrong window); the fallback is the first window owned by the
session's process.

**Tab** (invisible to X11 — only the terminal can select it):

| Terminal | Channel | Env var captured |
|---|---|---|
| Warp | `xdg-open warp://session/<uuid>` | `WARP_FOCUS_URL` |
| Tilix | `gdbus … org.gtk.Actions.Activate activate-terminal <id>` | `TILIX_ID` |

The decision logic (`pickWindow`/`tabChannel`) is a pure module,
[`src/focus.js`](src/focus.js) — `main.js` only does the I/O. On X11 the window
is raised, then the tab is selected; on Wayland the tab channel goes first
(wmctrl only sees XWayland).

### Event → state mapping (computeState, renderer)

| Adapter event | level | reason (sub-icon) |
|---|---|---|
| `SessionStart` | done 🟢 | ✓ (initial) |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | processing 🟡 | 🛠 |
| `Stop` | done 🟢 (→ awaiting 🔴⏰ if idle > 5 min) | ✓ / ⏰ |
| `PermissionRequest` | awaiting 🔴 | 🔑 |
| `Notification` | awaiting 🔴 **only if input is needed** | ❓ |
| `PostToolUseFailure` | awaiting 🔴 | ⚠️ |

## Adding a new agent

Two steps — the app adapts to whatever you declare:

1. **Register it** in [`src/agents.js`](src/agents.js): one line with `label`
   (UI), `comm` (process names in `/proc/<pid>/comm`, for detecting live
   sessions that don't have a state file yet).
2. **Write an adapter**: anything that writes state files following the
   contract above. [`hooks/traffic-hook.sh`](hooks/traffic-hook.sh) is the
   reference implementation — and it already serves **two** agents: for
   Gemini CLI it runs with `AI_TL_AGENT=gemini` and translates the event
   dialect (`BeforeAgent`→`UserPromptSubmit`, `BeforeTool`→`PreToolUse`,
   `AfterTool`→`PostToolUse`, `AfterAgent`→`Stop`) into the canonical
   vocabulary, so the renderer never learns per-agent dialects.

For Node-based CLIs whose process `comm` is just `node` (Gemini), the
`/proc` probe identifies sessions by the script basename in the process
argv — declared via the `argv` field in the registry.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Troubleshooting

- **Overlay shows "no active sessions"** — did you run `npm run setup-hook`?
  Already-open sessions only appear after their next event (send any prompt).
- **Click doesn't focus / focuses the wrong window** — check `wmctrl` and
  `xdotool` are installed; on Wayland they don't work (roadmap). The exact-tab
  jump only works in Warp for now.
- **Wayland** — the overlay itself runs fine (XWayland). Native-Wayland
  windows can't be focused by third parties, so click-to-focus relies on the
  terminal's focus URI (Warp today); the global shortcut may not fire while a
  native-Wayland app has focus. Workarounds: click the tray icon, or bind a
  GNOME custom shortcut to the app's launch command — **relaunching toggles
  the overlay** (single-instance).
- **Where is my data?** — `${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/`
  (state files, window position, aliases). Delete it freely; it regenerates.
- **Renderer debug** — `ATL_DEBUG=1 npm start` logs to `/tmp/atl-renderer.log`.

## Development

```bash
npm install
npm start
```

Test the adapter standalone:

```bash
echo '{"session_id":"t","hook_event_name":"Stop","cwd":"/tmp"}' | bash hooks/traffic-hook.sh
cat "${XDG_DATA_HOME:-$HOME/.local/share}/ai-traffic-lights/state/t.json" | jq .
```

## Roadmap

- [x] Gemini CLI adapter (hooks) + idle detection via argv probe
- [x] OpenCode adapter (plugin: chat/tool/idle/permission events, model
  capture — see `adapters/opencode/`)
- [x] Codex adapter (same hooks schema as Claude; model from payload) — note:
  after `setup-hook`, run `/hooks` in the Codex CLI once to trust the hook
- [x] Packaging: AppImage + .deb (electron-builder) — see [Releases](https://github.com/aronpc/ai-traffic-lights/releases)
- [x] Test suite (`node:test`) + CI
- [x] Reliable click-to-focus: window-id validation + exact tab in Warp
  (`focus_url`) and Tilix (`TILIX_ID` via D-Bus)
- [ ] Tab focus for terminals without a native channel (GNOME Terminal,
  zellij/tmux)
- [ ] Full native-Wayland window focus (today: XWayland + Warp focus URI +
  relaunch-to-toggle)
- [x] Configurable idle threshold & shortcut (tray → Preferences — stored in
  `~/.local/share/ai-traffic-lights/settings.json`)

## License

[MIT](LICENSE)
