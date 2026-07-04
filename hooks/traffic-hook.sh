#!/usr/bin/env bash
# traffic-hook.sh — adapter de hooks do ai-traffic-lights.
#
# Serve DOIS agentes (payloads de hook quase idênticos — session_id,
# hook_event_name, cwd, tool_name via stdin):
#   Claude Code  → instalado em ~/.claude/settings.json  (AI_TL_AGENT ausente)
#   Gemini CLI   → instalado em ~/.gemini/settings.json  (AI_TL_AGENT=gemini)
# Eventos do Gemini são traduzidos pro vocabulário canônico do contrato
# (BeforeAgent→UserPromptSubmit, BeforeTool→PreToolUse, AfterTool→PostToolUse,
# AfterAgent→Stop) — o renderer nunca precisa conhecer dialetos.
#
# Filosofia (revisão v5): este hook SÓ REGISTRA EVENTOS (append-only).
# NÃO computa o estado do semáforo — isso fica no renderer (computeState),
# porque a escalada idle (verde→vermelho após N min) exige relógio.
#
# Grava: ${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session_id>.json
#
# Requisito duro: RÁPIDO (<25ms) e nunca falha — roda em TODO tool call
# de TODA sessão (blast radius global). Quase tudo é fork-free:
#  - stdin slurpado com `read` (sem cat)
#  - session_id extraído com regex bash (sem jq)
#  - pid do claude subindo /proc/comm + /proc/status (sem `ps`, que custa ~75ms)
#  - timestamp via `printf %(%s)T` (sem `date`)
#  - estado existente lido com `$(<)` (sem cat)
#  - UMA única chamada jq monta o JSON final
# Único fork inevitável: `mv` (escrita atômica). mkdir só na 1ª chamada.

set -u
STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ai-traffic-lights/state"
AGENT="${AI_TL_AGENT:-claude}"              # qual agente registrou este hook

main() {
  local input
  IFS= read -rd '' input || true          # slurpa stdin sem fork
  [ -z "$input" ] && return 0

  # session_id via regex bash (fork-free) — decide o nome do arquivo.
  # Validação anti-path-traversal: só [A-Za-z0-9._-]. Um payload com "../"
  # (de um agente malicioso/bugado) NÃO pode escapar do STATE_DIR.
  local sid=""
  if [[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    sid="${BASH_REMATCH[1]}"
  fi
  if [[ ! $sid =~ ^[A-Za-z0-9._-]+$ ]]; then return 0; fi

  # hook_event_name via regex bash (fork-free) — usado 3x abaixo
  local evt=""
  if [[ $input =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    evt="${BASH_REMATCH[1]}"
  fi

  # Tradução de dialeto → vocabulário canônico do contrato (fork-free).
  # Eventos desconhecidos passam crus (computeState trata como verde).
  if [ "$AGENT" = "gemini" ]; then
    case "$evt" in
      BeforeAgent) evt="UserPromptSubmit" ;;
      BeforeTool)  evt="PreToolUse" ;;
      AfterTool)   evt="PostToolUse" ;;
      AfterAgent)  evt="Stop" ;;
    esac
  fi

  # SessionEnd: sessão encerrou limpo — remove o state file (não vira zombie).
  if [ "$evt" = "SessionEnd" ]; then
    rm -f "$STATE_DIR/${sid}.json" 2>/dev/null
    return 0
  fi
  # Model: preferido do payload (Codex manda "model" direto no JSON — sem
  # custo); fallback pro grep do transcript (Claude/Gemini). tail limita o custo
  # em transcripts grandes; \s* tolera JSONL compacto e JSON pretty-printed.
  local transcript="" model=""
  if [[ $input =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    transcript="${BASH_REMATCH[1]}"
  fi
  if [[ $input =~ \"model\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    model="${BASH_REMATCH[1]}"
  elif [ -n "$transcript" ] && [ -f "$transcript" ]; then
    model=$(tail -n 5000 "$transcript" 2>/dev/null | grep -oP '"model"\s*:\s*"\K[^"]+' | tail -1)
  fi

  # notification_type (evento Notification do Claude Code): é o DISCRIMINADOR
  # entre "precisa de você" (permission_prompt, idle_prompt, elicitation_dialog)
  # e benigno (auth_success, elicitation_complete, elicitation_response). O
  # renderer classifica por este campo — nunca pela message (instável, i18n).
  local ntype=""
  if [[ $input =~ \"notification_type\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    ntype="${BASH_REMATCH[1]}"
  fi

  # Sobe a árvore até achar o processo do agente. Zero forks.
  # claude: binário próprio (comm=claude). gemini: script Node (comm=node) —
  # o PRIMEIRO ancestral node é o gemini. codex: binário Rust (comm=codex).
  local agent_pid=$$ pid=$$ comm="" ppid=""
  while [ "${pid:-0}" -gt 1 ] 2>/dev/null; do
    comm=""
    read -r comm < "/proc/$pid/comm" 2>/dev/null
    case "$AGENT:$comm" in
      claude:claude|claude:claude-agent-acp|gemini:node|codex:codex) agent_pid="$pid"; break ;;
    esac
    ppid=""
    while IFS=$' \t' read -r k v; do
      [ "$k" = "PPid:" ] && { ppid="$v"; break; }
    done < "/proc/$pid/status" 2>/dev/null
    [ -z "$ppid" ] && break
    pid="$ppid"
  done

  # Canais nativos de foco de aba (invisível pro X11; só o terminal alcança):
  #  Warp  → WARP_FOCUS_URL (warp://session/<uuid>) via xdg-open
  #  Tilix → TILIX_ID (uuid) via gdbus activate-terminal
  local win="${WINDOWID:-}" tp="${TERM_PROGRAM:-}" zs="${ZELLIJ_SESSION_NAME:-}"
  local furl="${WARP_FOCUS_URL:-}" tid="${TILIX_ID:-}"

  # windowid REAL: no UserPromptSubmit/SessionStart a janela focada do desktop
  # É o terminal da sessão (o usuário acabou de digitar nela). Resolve Warp
  # (multi-janela, WINDOWID vazio) e zellij/tmux (árvore de processos descolada
  # do terminal). 1 fork, só em eventos de prompt (raros) — budget preservado.
  local awin=""
  if [ "$evt" = "UserPromptSubmit" ] || [ "$evt" = "SessionStart" ]; then
    if [ -n "${DISPLAY:-}" ] && command -v xdotool >/dev/null 2>&1; then
      awin=$(xdotool getactivewindow 2>/dev/null) || awin=""
    fi
  fi

  local ts
  printf -v ts '%(%s)T' -1                   # epoch fork-free (bash 4.2+)

  [ -d "$STATE_DIR" ] || mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  local file="$STATE_DIR/${sid}.json"

  local existing=""
  [ -f "$file" ] && existing=$(<"$file")     # idiom bash (sem cat); só lê se existir

  # 1 jq: extrai campos do input ($in) + merge com existente ($ex) + rolling
  # windowid: prioriza a janela ativa capturada agora ($awin); senão WINDOWID
  # do ambiente; senão PRESERVA o valor já gravado (não regride pra null).
  # $existing entra como STRING e é parseado com try/fromjson: arquivo vazio,
  # truncado ou corrompido (race de escrita) vira {} e o state se regenera no
  # próximo evento — sem isso, um state quebrado travaria a sessão pra sempre.
  jq -n -c \
    --argjson in "$input" \
    --arg exs "$existing" \
    --argjson pid "$agent_pid" \
    --argjson ts "$ts" \
    --arg agent "$AGENT" --arg cevt "$evt" \
    --arg awin "$awin" --arg furl "$furl" --arg tid "$tid" \
    --arg win "$win" --arg tp "$tp" --arg zs "$zs" --arg model "$model" --arg tpath "$transcript" --arg ntype "$ntype" '
      (try ($exs | fromjson) catch {}) as $ex
      | ($in.session_id // "") as $sid
      | $cevt as $evt
      | ($in.cwd // "") as $cwd
      | ($in.tool_name // "") as $tool
      | {
          schema_version: 2,
          agent: $agent,
          session_id: $sid, pid: $pid,
          cwd: (if $cwd == "" then null else $cwd end),
          transcript_path: (if $tpath == "" then null else $tpath end),
          model: (if $model == "" then null else $model end),
          term_program: (if $tp == "" then null else $tp end),
          windowid: (if $awin != "" then $awin elif $win != "" then $win else ($ex.windowid // null) end),
          focus_url: (if $furl != "" then $furl else ($ex.focus_url // null) end),
          tilix_id: (if $tid != "" then $tid else ($ex.tilix_id // null) end),
          zellij_session: (if $zs == "" then null else $zs end),
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
