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

  # session_id via regex bash (fork-free) — decide o nome do arquivo
  local sid=""
  if [[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    sid="${BASH_REMATCH[1]}"
  fi
  [ -z "$sid" ] && return 0

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
  # tail -n 5000 limita o custo em transcripts grandes; grep -P extrai só o valor.
  local transcript="" model=""
  if [[ $input =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    transcript="${BASH_REMATCH[1]}"
    if [ -f "$transcript" ]; then
      model=$(tail -n 5000 "$transcript" 2>/dev/null | grep -oP '"model":"\K[^"]+' | tail -1)
    fi
  fi

  # Sobe a árvore até achar o processo do agente. Zero forks.
  # claude: binário próprio (comm=claude). gemini: script Node (comm=node) —
  # o PRIMEIRO ancestral node é o gemini (cadeia: bash-hook → node-gemini).
  local agent_pid=$$ pid=$$ comm="" ppid=""
  while [ "${pid:-0}" -gt 1 ] 2>/dev/null; do
    comm=""
    read -r comm < "/proc/$pid/comm" 2>/dev/null
    case "$AGENT:$comm" in
      claude:claude|claude:claude-agent-acp|gemini:node) agent_pid="$pid"; break ;;
    esac
    ppid=""
    while IFS=$' \t' read -r k v; do
      [ "$k" = "PPid:" ] && { ppid="$v"; break; }
    done < "/proc/$pid/status" 2>/dev/null
    [ -z "$ppid" ] && break
    pid="$ppid"
  done

  # focus_url: URI nativa de foco do terminal, quando existir. Warp exporta
  # WARP_FOCUS_URL (warp://session/<uuid>) — abrir essa URI faz raise da janela
  # E troca pra aba/pane da sessão (aba é invisível pro X11; só isso alcança).
  local win="${WINDOWID:-}" tp="${TERM_PROGRAM:-}" zs="${ZELLIJ_SESSION_NAME:-}" furl="${WARP_FOCUS_URL:-}"

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
    --arg awin "$awin" --arg furl "$furl" \
    --arg win "$win" --arg tp "$tp" --arg zs "$zs" --arg model "$model" --arg tpath "$transcript" '
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
          zellij_session: (if $zs == "" then null else $zs end),
          last_event: $evt, last_event_ts: $ts,
          last_tool: (if $tool == "" then null else $tool end),
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
