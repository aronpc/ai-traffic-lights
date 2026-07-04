# 🚦 AI Traffic Lights

**English** | [Português (Brasil)](README.pt-BR.md)

A translucent always-on-top overlay (Electron) that shows the state of every
**terminal AI agent session** on your desktop as a traffic light: 🟢 done ·
🟡 working · 🔴 needs you.

Monitors **Claude Code** today. The architecture is agent-agnostic — Gemini
CLI, Codex and OpenCode land via adapters (see [Adding an agent](#adding-a-new-agent)).

![AI Traffic Lights overlay](assets/screenshots/overlay.png)

## Why

When you run several AI agent sessions in parallel across terminals, tabs and
projects, you lose track of which one finished, which is still crunching, and
which has been silently waiting for your approval for ten minutes. This
overlay gives you one glance: a light per session, click to jump to its
terminal — **window _and_ tab**.

## Features

- 🟢🟡🔴 One light per session, plus an aggregate light in the header
- **Click-to-focus**: jumps to the session's terminal — the exact window, and
  in Warp the exact **tab** (via `warp://session/<uuid>`)
- 🔔 Beep + desktop notification when a session turns red (rate-limited)
- ⏰ Idle escalation: a finished session left unattended for 5 min turns red
- ✏️ Double-click to rename a session (aliases persist per project)
- Auto-height, drag anywhere, width-resizable, position persisted
- Tray icon (show/hide, autostart, quit) + global shortcut **`Ctrl+Alt+H`**
- Stays out of your way: no taskbar/alt-tab entry, never maximizes, no scrollbar

## Requirements

- **Linux + X11** (GNOME/Mutter tested; Wayland is on the roadmap)
- `wmctrl`, `xdotool`, `jq` — `sudo apt install wmctrl xdotool jq`
- Node.js 20+
- A supported agent: [Claude Code](https://claude.com/claude-code) today

## Install (from source)

```bash
git clone https://github.com/aronpc/ai-traffic-lights.git
cd ai-traffic-lights
npm install
npm run setup-hook   # registers the Claude Code adapter in ~/.claude/settings.json
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
  "focus_url": "warp://session/8726…", // terminal-native focus URI (Warp)
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

- **`windowid`**: at `UserPromptSubmit`/`SessionStart` the desktop's focused
  window **is** the session's terminal (you just typed in it). The adapter
  snapshots `xdotool getactivewindow` at that instant and preserves it across
  events. This disambiguates single-process multi-window terminals (Warp,
  Tilix, GNOME Terminal) and zellij/tmux (whose process tree leads to a
  daemonized server, not the visible terminal).
- **`focus_url`**: tabs don't exist in X11 — only the terminal itself can
  reach them. Warp exports `WARP_FOCUS_URL=warp://session/<uuid>` in every
  session; opening it raises the window **and** activates the exact tab/pane.
  Terminals with similar mechanisms plug in via the `FOCUS_URL_SCHEMES`
  allowlist (main.js).

`focusSession()` layers: exact `windowid` → process-ancestry fallback →
`focus_url` for the tab.

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
   contract above. The Claude Code adapter
   ([`hooks/traffic-hook.sh`](hooks/traffic-hook.sh)) is the reference
   implementation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Troubleshooting

- **Overlay shows "no active sessions"** — did you run `npm run setup-hook`?
  Already-open sessions only appear after their next event (send any prompt).
- **Click doesn't focus / focuses the wrong window** — check `wmctrl` and
  `xdotool` are installed; on Wayland they don't work (roadmap). The exact-tab
  jump only works in Warp for now.
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

- [ ] Adapters: Gemini CLI · Codex · OpenCode (research per-tool event mechanisms)
- [ ] Wayland support (focus + window position)
- [ ] Packaging: AppImage + .deb (electron-builder)
- [ ] Configurable idle threshold & shortcut

## License

[MIT](LICENSE)
