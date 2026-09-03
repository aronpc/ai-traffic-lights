#!/usr/bin/env bash
# traffic-hook.sh — hook adapter for ai-traffic-lights.
#
# Serves TWO agents (nearly identical hook payloads — session_id,
# hook_event_name, cwd, tool_name via stdin):
#   Claude Code  → installed in ~/.claude/settings.json  (AI_TL_AGENT absent)
#   Antigravity CLI → installed in ~/.gemini/antigravity-cli/settings.json (AI_TL_AGENT=antigravity)
#   Gemini CLI   → installed in ~/.gemini/settings.json  (AI_TL_AGENT=gemini)
# Gemini events are translated to the contract's canonical vocabulary
# (BeforeAgent→UserPromptSubmit, BeforeTool→PreToolUse, AfterTool→PostToolUse,
# AfterAgent→Stop) — the renderer never needs to know dialects. Antigravity uses
# the same events as Claude Code natively.
#
# Philosophy (v5 revision): this hook ONLY RECORDS EVENTS (append-only).
# It does NOT compute the traffic-light state — that lives in the renderer
# (computeState), because idle escalation (green→red after N min) requires
# a clock.
#
# Writes to: ${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json
#
# Hard requirement: FAST (<25ms) and never fails — runs on EVERY tool call
# of EVERY session (global blast radius). Almost everything is fork-free:
#  - stdin slurped with `read` (no cat)
#  - session_id extracted with bash regex (no jq)
#  - claude pid found by walking /proc/comm + /proc/status (no `ps`, which costs ~75ms)
#  - timestamp via `printf %(%s)T` (no `date`)
#  - existing state read with `$(<)` (no cat)
#  - a SINGLE jq call assembles the final JSON
# Only unavoidable fork: `mv` (atomic write). mkdir only on the 1st call.

set -u
STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ai-traffic-lights/state"
AGENT="${AI_TL_AGENT:-claude}"              # which agent recorded this hook

main() {
  local input
  IFS= read -rd '' input || true          # slurps stdin without a fork
  [ -z "$input" ] && return 0

  # session_id via bash regex (fork-free) — determines the file name.
  # Anti-path-traversal validation: only [A-Za-z0-9._-]. A payload with "../"
  # (from a malicious/buggy agent) must NOT escape STATE_DIR.
  local sid=""
  if [[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    sid="${BASH_REMATCH[1]}"
  fi
  if [[ ! $sid =~ ^[A-Za-z0-9._-]+$ ]]; then return 0; fi

  # hook_event_name via bash regex (fork-free) — used 3x below
  local evt=""
  if [[ $input =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    evt="${BASH_REMATCH[1]}"
  fi

  # Dialect translation → contract's canonical vocabulary (fork-free).
  # Unknown events pass through raw (computeState treats them as green).
  if [ "$AGENT" = "gemini" ]; then
    case "$evt" in
      BeforeAgent) evt="UserPromptSubmit" ;;
      BeforeTool)  evt="PreToolUse" ;;
      AfterTool)   evt="PostToolUse" ;;
      AfterAgent)  evt="Stop" ;;
    esac
  elif [ "$AGENT" = "antigravity" ]; then
    case "$evt" in
      PreInvocation)  evt="UserPromptSubmit" ;;
      PreToolUse)     evt="PreToolUse" ;;
      PostToolUse)    evt="PostToolUse" ;;
      PostInvocation) evt="Stop" ;;
      Stop)           evt="Stop" ;;
    esac
  fi

  # SessionEnd: session ended cleanly — removes the state file (doesn't become a zombie).
  if [ "$evt" = "SessionEnd" ]; then
    rm -f "$STATE_DIR/${sid}.json" 2>/dev/null
    return 0
  fi
  # Model: preferred from the payload (Codex sends "model" directly in the
  # JSON — no cost); falls back to grepping the transcript (Claude/Gemini).
  # tail bounds the cost on large transcripts; \s* tolerates both compact
  # JSONL and pretty-printed JSON.
  local transcript="" model=""
  if [[ $input =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    transcript="${BASH_REMATCH[1]}"
  fi
  if [[ $input =~ \"model\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    model="${BASH_REMATCH[1]}"
  elif [ -n "$transcript" ] && [ -f "$transcript" ]; then
    model=$(tail -n 5000 "$transcript" 2>/dev/null | grep -oP '"model"\s*:\s*"\K[^"]+' | tail -1)
  fi

  # notification_type (Claude Code Notification event): it is the DISCRIMINATOR
  # between "needs you" (permission_prompt, idle_prompt, elicitation_dialog)
  # and benign (auth_success, elicitation_complete, elicitation_response). The
  # renderer classifies by this field — never by message (unstable, i18n).
  local ntype=""
  if [[ $input =~ \"notification_type\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    ntype="${BASH_REMATCH[1]}"
  fi

  # Walks up the tree until it finds the agent process. Zero forks on Linux.
  # On macOS (no /proc), we use ps.
  local agent_pid=$$ pid=$$ comm="" ppid=""
  if [ -d "/proc" ]; then
    while [ "${pid:-0}" -gt 1 ] 2>/dev/null; do
      comm=""
      read -r comm < "/proc/$pid/comm" 2>/dev/null
      case "$AGENT:$comm" in
        claude:claude|claude:claude-agent-acp|gemini:node|antigravity:node|antigravity:agy|antigravity:antigravity|codex:codex) agent_pid="$pid"; break ;;
      esac
      ppid=""
      while IFS=$' \t' read -r k v; do
        [ "$k" = "PPid:" ] && { ppid="$v"; break; }
      done < "/proc/$pid/status" 2>/dev/null
      [ -z "$ppid" ] && break
      pid="$ppid"
    done
  else
    while [ "${pid:-0}" -gt 1 ] 2>/dev/null; do
      local ps_out
      ps_out=$(ps -p "$pid" -o ppid=,comm= 2>/dev/null)
      ppid="" comm=""
      read -r ppid comm <<< "$ps_out"
      comm="${comm##*/}"  # fork-free basename (avoids "basename: illegal option" under -zsh)
      case "$AGENT:$comm" in
        claude:claude|claude:claude-agent-acp|gemini:node|antigravity:node|antigravity:agy|antigravity:antigravity|codex:codex) agent_pid="$pid"; break ;;
      esac
      [ -z "$ppid" ] && break
      pid="$ppid"
    done
  fi

  # Native tab-focus channels (invisible to X11; only the terminal can reach them):
  #  Warp  → WARP_FOCUS_URL (warp://session/<uuid>) via xdg-open
  #  Tilix → TILIX_ID (uuid) via gdbus activate-terminal
  local win="${WINDOWID:-}" tp="${TERM_PROGRAM:-}" zs="${ZELLIJ_SESSION_NAME:-}"
  local furl="${WARP_FOCUS_URL:-}" tid="${TILIX_ID:-}"
  # tmux: session name (for remote attach "tmux attach -t <name>"). The capture
  # happens BELOW, after reading the state file: the name doesn't change within
  # the same session, so the persisted value is reused (zero forks) and
  # `tmux display-message` runs only the 1st time — not on every event.
  # tmux_pane ($TMUX_PANE, e.g. "%3"): for LOCAL pane FOCUS (zero forks, it's env).
  local tmuxs="" tmuxp="${TMUX_PANE:-}"
  # iTerm2 (macOS): ITERM_SESSION_ID = "w0t0p0:<uuid>" → exact tab focus via
  # osascript. Reading an already-exported env var: zero forks, budget intact.
  local iid="${ITERM_SESSION_ID:-}"

  # REAL windowid: on UserPromptSubmit/SessionStart the desktop's focused
  # window IS the session's terminal (the user just typed in it). Resolves Warp
  # (multi-window, empty WINDOWID) and zellij/tmux (process tree detached from
  # the terminal). 1 fork, only on prompt events (rare) — budget preserved.
  local awin=""
  if [ "$evt" = "UserPromptSubmit" ] || [ "$evt" = "SessionStart" ]; then
    if [ -n "${DISPLAY:-}" ] && command -v xdotool >/dev/null 2>&1; then
      awin=$(xdotool getactivewindow 2>/dev/null) || awin=""
    fi
  fi

  local ts
  if ! printf -v ts '%(%s)T' -1 2>/dev/null || [ -z "${ts:-}" ]; then
    ts=$(date +%s)
  fi

  [ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  local file="$STATE_DIR/${sid}.json"

  local existing=""
  [ -f "$file" ] && existing=$(<"$file")     # bash idiom (no cat); only reads if it exists

  # tmux_session: reuses the already-persisted value (regex over the compact
  # JSON, zero forks); only queries the tmux binary the 1st time, when no value exists.
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    if [ -n "$existing" ]; then
      [[ $existing =~ \"tmux_session\":\ ?\"([^\"]+)\" ]] && tmuxs="${BASH_REMATCH[1]}"
    fi
    if [ -z "$tmuxs" ]; then
      tmuxs=$(tmux display-message -p '#S' 2>/dev/null) || tmuxs=""
    fi
  fi

  # 1 jq: extracts fields from the input ($in) + merge with existing ($ex) +
  # rolling windowid: prefers the active window captured now ($awin); else the
  # environment's WINDOWID; else PRESERVES the already-stored value (never
  # regresses to null).
  # $existing enters as a STRING and is parsed with try/fromjson: an empty,
  # truncated or corrupted file (write race) becomes {} and the state
  # regenerates on the next event — without this, a broken state would lock
  # the session forever.
  jq -n -c \
    --argjson in "$input" \
    --arg exs "$existing" \
    --argjson pid "$agent_pid" \
    --argjson ts "$ts" \
    --arg agent "$AGENT" --arg cevt "$evt" \
    --arg awin "$awin" --arg furl "$furl" --arg tid "$tid" --arg iid "$iid" \
    --arg win "$win" --arg tp "$tp" --arg zs "$zs" --arg tmuxs "$tmuxs" --arg tmuxp "$tmuxp" --arg model "$model" --arg tpath "$transcript" --arg ntype "$ntype" '
      (try ($exs | fromjson) catch {}) as $ex
      | ($in.session_id // "") as $sid
      | $cevt as $evt
      | ($in.cwd // "") as $cwd
      | ($in.tool_name // "") as $tool
      | $ex + {
          schema_version: 2,
          agent: $agent,
          session_id: $sid, pid: $pid,
          cwd: (if $cwd == "" then ($ex.cwd // null) else $cwd end),
          transcript_path: (if $tpath == "" then ($ex.transcript_path // null) else $tpath end),
          model: (if $model == "" then ($ex.model // null) else $model end),
          term_program: (if $tp == "" then ($ex.term_program // null) else $tp end),
          windowid: (if $awin != "" then $awin elif $win != "" then $win else ($ex.windowid // null) end),
          focus_url: (if $furl != "" then $furl else ($ex.focus_url // null) end),
          tilix_id: (if $tid != "" then $tid else ($ex.tilix_id // null) end),
          zellij_session: (if $zs == "" then ($ex.zellij_session // null) else $zs end),
          tmux_session: (if $tmuxs == "" then ($ex.tmux_session // null) else $tmuxs end),
          tmux_pane: (if $tmuxp == "" then ($ex.tmux_pane // null) else $tmuxp end),
          iterm_id: (if $iid != "" then $iid else ($ex.iterm_id // null) end),
          last_event: $evt, last_event_ts: $ts,
          last_tool: (if $tool == "" then null else $tool end),
          notification_type: (if $ntype == "" then null else $ntype end),
          events: (($ex.events // []) + [{
            ts: $ts, event: $evt,
            tool: (if $tool == "" then null else $tool end)
          }]) | .[-50:]
        }
    ' >"$file.tmp" 2>/dev/null \
    && mv -f "$file.tmp" "$file" 2>/dev/null

  return 0
}

main "$@"
exit 0
