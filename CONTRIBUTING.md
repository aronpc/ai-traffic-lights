# Contributing to AI Traffic Lights

Thanks for your interest! Issues and PRs are welcome in **English or
Portuguese** — pick whichever you're comfortable with.

## Dev setup

```bash
git clone https://github.com/aronpc/ai-traffic-lights.git
cd ai-traffic-lights
npm install
npm run setup-hook   # optional: feed the overlay with your real Claude Code sessions
npm start
```

Requirements: Linux + X11, Node 20+, `wmctrl`, `xdotool`, `jq`.

## Project layout

```
main.js              Electron main: window, tray, /proc probe, focus, reaper
preload.js           contextBridge (renderer never touches Node APIs)
src/agents.js        agent registry — single source of truth (UI + /proc probe)
src/state-machine.js pure function: state file → 🟢🟡🔴 (easy to test)
src/renderer.js      list rendering, alerts, rename, resize
hooks/traffic-hook.sh  Claude Code adapter (reference implementation)
scripts/setup-hook.js  installs/removes the adapter in ~/.claude/settings.json
```

Code comments are currently written in Portuguese (pt-BR) — contributions in
English are fine; consistency per file is appreciated.

## The one contract that matters: the state file

The overlay never talks to any AI tool directly. It watches
`${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/` and renders
whatever valid JSON it finds there (schema documented in the
[README](README.md#state-file-contract-schema_version-2)).

That means **adding support for a new agent doesn't require touching the
Electron app**:

1. Add one line to `src/agents.js` (`label` + `comm` process names).
2. Write an adapter that turns the agent's lifecycle events into state-file
   writes. `hooks/traffic-hook.sh` is the reference: append-only event log,
   atomic writes (`tmp` + `mv`), self-healing against corrupted files
   (`try/fromjson`), and **fast** — it runs on every tool call of every
   session, so the budget is <25ms, fork-free wherever possible.

Adapter checklist:

- [ ] Writes `<state-dir>/state/<session_id>.json` following the schema
- [ ] Sets `agent` to its registry key
- [ ] Removes the file on clean session end (or leaves it to the PID reaper)
- [ ] Never blocks or fails loudly — the host tool must never notice it
- [ ] Documents which extra fields it can/cannot fill (`windowid`, `focus_url`)

## Testing

The hook can be exercised standalone:

```bash
echo '{"session_id":"t","hook_event_name":"Stop","cwd":"/tmp"}' | bash hooks/traffic-hook.sh
cat "${XDG_DATA_HOME:-$HOME/.local/share}/ai-traffic-lights/state/t.json" | jq .
echo '{"session_id":"t","hook_event_name":"SessionEnd"}' | bash hooks/traffic-hook.sh  # cleanup
```

There's a test suite (`node:test`, no dependencies):

```bash
npm test
```

- `test/state-machine.test.js` — the pure `computeState`/`iconFor`/`agentOf`
  functions. Touch the event → color mapping? Add/adjust a case here.
- `test/rename.test.js` — loads the real renderer scripts in a `vm` with a
  mock DOM and drives the actual dblclick/keydown/blur handlers (regression
  for #2). It's the pattern to copy for other renderer behavior.

CI (`.github/workflows/ci.yml`) runs the syntax checks and `npm test` on every
push and PR. Before opening a PR, the same checks locally:

```bash
bash -n hooks/traffic-hook.sh
node --check main.js preload.js src/*.js scripts/*.js
npm test
```

## PR guidelines

- Small, focused PRs beat big ones.
- Explain the *why*, not just the *what* — this codebase documents decisions
  in comments and README; keep that habit.
- **Update [`CHANGELOG.md`](CHANGELOG.md)** under `[Unreleased]` (Added /
  Changed / Fixed / Removed) for anything a user would notice. User-visible
  changes always get a line; pure refactors/test additions don't.
- Schema changes: bump `schema_version`, update **both** READMEs and keep the
  renderer backward-compatible with the previous version.
- UI changes: include a screenshot.

## Reporting bugs

Include: distro + desktop (X11/Wayland), terminal emulator, `node -v`, what
the overlay showed vs. what you expected, and if possible the relevant state
file from `~/.local/share/ai-traffic-lights/state/` (redact paths if needed).
