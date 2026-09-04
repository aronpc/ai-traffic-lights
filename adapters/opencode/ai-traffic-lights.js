// ai-traffic-lights.js — OpenCode adapter for ai-traffic-lights (plugin).
//
// Installed to ~/.config/opencode/plugin/ by `npm run setup-hook` (or by the
// tray menu). Runs INSIDE the OpenCode process and writes the state file
// contract read by the overlay:
//   ${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session>.json
//
// Event → canonical contract vocabulary mapping:
//   chat.message / message user           → UserPromptSubmit (captures active window)
//   tool.execute.before / after           → PreToolUse / PostToolUse
//   tool.execute.before (ask/question)    → Question (🔴❓) — asks the user
//   session.idle                          → Stop
//   permission.ask (HOOK) / .asked        → PermissionRequest (🔴🔑) — asked for permission
//   permission.replied / .updated         → Stop (answered → leaves red)
//   session.error                         → PostToolUseFailure (🔴⚠)
//   session.deleted                       → removes the state file
//
// IMPORTANT: OpenCode asks for permission via the `permission.ask` HOOK
// (function) and the `permission.asked` event — NOT via `permission.updated`
// (which the adapter listened to before and never fired on ask). See
// @opencode-ai/plugin types.
//
// Golden rule: NEVER break OpenCode — every hook swallows exceptions.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share")
const STATE_DIR = path.join(DATA_HOME, "ai-traffic-lights", "state")

export const AiTrafficLights = async ({ directory, $ }) => {
  // Terminal context captured at boot (the process inherits the shell's env).
  const boot = {
    term_program: process.env.TERM_PROGRAM || null,
    windowid: process.env.WINDOWID || null,
    focus_url: process.env.WARP_FOCUS_URL || null,  // Warp: warp://session/<uuid>
    tilix_id: process.env.TILIX_ID || null,         // Tilix: uuid for activate-terminal
    zellij_session: process.env.ZELLIJ_SESSION_NAME || null,
    tmux_session: null,   // resolved below (session name for remote attach)
    tmux_pane: process.env.TMUX_PANE || null,   // pane id (%N) for local FOCUS (LOCAL_ONLY)
  }
  // tmux: the session name can only be obtained via CLI (there is no env var).
  // 1 fork at boot, only if $TMUX is set — agents outside tmux => zero cost.
  if (process.env.TMUX) {
    try { boot.tmux_session = execSync("tmux display-message -p '#S'", { encoding: "utf8", timeout: 1000 }).trim() || null; }
    catch { /* no tmux/error => stays null */ }
  }
  let lastModel = null    // last modelID seen (assistant messages)
  let capturedWin = null  // active window at the last prompt (X11)
  const lastIdleAt = new Map()   // sessionID -> ms of the last session.idle — anti-clobber window for Stop (per session, not global)

  // USER QUESTION tools: when the agent calls one of these, it is WAITING for
  // your answer — it's a "needs you" (🔴🔑), not a normal work step (green).
  // Autonomous frameworks (oh-my-openagent) ask via TOOL, not via OpenCode's
  // permission flow — so this is where the red actually fires in those setups.
  const QUESTION_TOOLS = new Set(['ask', 'question', 'ask_user_question', 'askuserquestion'])
  const isQuestionTool = (name) => QUESTION_TOOLS.has(String(name || '').toLowerCase().replace(/[-\s]/g, '_'))

  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return {} }
  }

  // Atomic write (tmp + rename), merge-preserve of windowid/focus_url,
  // rolling events (last 50) — same behavior as traffic-hook.sh.
  // Safe ID for filenames (anti-path-traversal). Rejects "../", spaces,
  // etc. — it comes from external payload.
  const SAFE_ID = /^[A-Za-z0-9._-]+$/

  const write = (sid, evt, tool) => {
    if (!sid || !SAFE_ID.test(sid)) return
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const file = path.join(STATE_DIR, `${sid}.json`)
      const ex = read(file)
      const now = Math.floor(Date.now() / 1000)
      const st = {
        ...ex,
        schema_version: 2,
        agent: "opencode",
        session_id: sid,
        pid: process.pid,
        cwd: directory || process.cwd() || null,
        transcript_path: ex.transcript_path || null,
        model: lastModel || ex.model || null,
        term_program: boot.term_program || ex.term_program || null,
        windowid: capturedWin || ex.windowid || boot.windowid || null,
        focus_url: boot.focus_url || ex.focus_url || null,
        tilix_id: boot.tilix_id || ex.tilix_id || null,
        zellij_session: boot.zellij_session || ex.zellij_session || null,
        tmux_session: boot.tmux_session || ex.tmux_session || null,
        tmux_pane: boot.tmux_pane || ex.tmux_pane || null,
        last_event: evt,
        last_event_ts: now,
        last_tool: tool || null,
        events: [
          ...(Array.isArray(ex.events) ? ex.events : []),
          { ts: now, event: evt, tool: tool || null },
        ].slice(-50),
      }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(st))
      fs.renameSync(`${file}.tmp`, file)
    } catch {}
  }

  const drop = (sid) => {
    if (!sid || !SAFE_ID.test(sid)) return
    try { fs.unlinkSync(path.join(STATE_DIR, `${sid}.json`)) } catch {}
  }

  // On the user's prompt, the focused window IS the session's terminal (same
  // technique as the Claude/Gemini adapter) — disambiguates multi-window Warp.
  const captureWindow = async () => {
    if (!process.env.DISPLAY) return
    try {
      const r = await $`xdotool getactivewindow`.quiet().nothrow()
      const out = (r?.stdout?.toString() || "").trim()
      if (/^\d+$/.test(out)) capturedWin = out
    } catch {}
  }

  return {
    "chat.message": async (_input, output) => {
      try {
        const m = (output && output.message) || {}
        await captureWindow()
        write(m.sessionID, "UserPromptSubmit", null)
      } catch {}
    },

    "tool.execute.before": async (input) => {
      try {
        const tool = input && input.tool
        // question tool → 🔴❓ (awaiting answer); the others → green (running)
        write(input && input.sessionID, isQuestionTool(tool) ? "Question" : "PreToolUse", tool)
      } catch {}
    },

    "tool.execute.after": async (input) => {
      try { write(input && input.sessionID, "PostToolUse", input && input.tool) } catch {}
    },

    // OpenCode calls this HOOK when it ASKS for permission (edit/bash/etc.). It
    // is the main path — fires BEFORE the user answers. Marks 🔴🔑.
    "permission.ask": async (input) => {
      try { write(input && input.sessionID, "PermissionRequest", null) } catch {}
    },

    event: async ({ event }) => {
      try {
        const t = event && event.type
        const p = (event && event.properties) || {}
        const info = p.info || {}
        const sid = p.sessionID || info.sessionID || info.id || null

        if (t === "message.updated") {
          if (info.role === "assistant" && info.modelID) lastModel = info.modelID
          // fallback for versions without the chat.message hook. opencode
          // re-emits message.updated for the user role on message STABILIZATION,
          // right after session.idle — if UserPromptSubmit were re-written there,
          // the Stop would be overwritten and the session would stay 💛 stuck on
          // the last prompt (bug seen: a session that ended without tools stayed
          // yellow forever). 2s window.
          if (info.role === "user" && Date.now() - (lastIdleAt.get(sid) || 0) >= 2000) {
            await captureWindow(); write(sid, "UserPromptSubmit", null)
          }
          return
        }
        if (t === "session.idle") { lastIdleAt.set(sid, Date.now()); return write(sid, "Stop", null) }
        // asked for permission → 🔴🔑 (permission.asked is the event; the
        // permission.ask hook above is the main path — both are idempotent)
        if (t === "permission.ask" || t === "permission.asked") return write(sid, "PermissionRequest", null)
        // answered (allow/deny) → leaves red; the next tool/idle adjusts the color
        if (t === "permission.replied" || t === "permission.updated") return write(sid, "Stop", null)
        if (t === "session.error") return write(sid, "PostToolUseFailure", null)
        if (t === "session.deleted") return drop(sid)
      } catch {}
    },
  }
}
