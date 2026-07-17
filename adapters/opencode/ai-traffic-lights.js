// ai-traffic-lights.js — adapter OpenCode do ai-traffic-lights (plugin).
//
// Instalado em ~/.config/opencode/plugin/ pelo `npm run setup-hook` (ou pelo
// menu do tray). Roda DENTRO do processo do OpenCode e escreve o contrato de
// state file lido pelo overlay:
//   ${XDG_DATA_HOME:-~/.local/share}/ai-traffic-lights/state/<session>.json
//
// Tradução de eventos → vocabulário canônico do contrato:
//   chat.message / message user           → UserPromptSubmit (captura janela ativa)
//   tool.execute.before / after           → PreToolUse / PostToolUse
//   tool.execute.before (ask/question)    → Question (🔴❓) — pergunta ao usuário
//   session.idle                          → Stop
//   permission.ask (HOOK) / .asked        → PermissionRequest (🔴🔑) — pediu permissão
//   permission.replied / .updated         → Stop (respondeu → sai do vermelho)
//   session.error                         → PostToolUseFailure (🔴⚠)
//   session.deleted                       → remove o state file
//
// IMPORTANTE: o OpenCode pede permissão pelo HOOK `permission.ask` (função) e
// pelo evento `permission.asked` — NÃO por `permission.updated` (que o adapter
// escutava antes e nunca disparava ao pedir). Ver @opencode-ai/plugin types.
//
// Regra de ouro: NUNCA quebrar o OpenCode — todo hook engole exceções.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execSync } from "node:child_process"

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share")
const STATE_DIR = path.join(DATA_HOME, "ai-traffic-lights", "state")

export const AiTrafficLights = async ({ directory, $ }) => {
  // Contexto do terminal capturado no boot (o processo herda o env do shell).
  const boot = {
    term_program: process.env.TERM_PROGRAM || null,
    windowid: process.env.WINDOWID || null,
    focus_url: process.env.WARP_FOCUS_URL || null,  // Warp: warp://session/<uuid>
    tilix_id: process.env.TILIX_ID || null,         // Tilix: uuid p/ activate-terminal
    zellij_session: process.env.ZELLIJ_SESSION_NAME || null,
    tmux_session: null,   // resolvido abaixo (nome da sessão p/ attach remoto)
  }
  // tmux: nome da sessão só é obtido via CLI (não há env var). 1 fork no boot,
  // só se $TMUX set — agentes fora do tmux => zero custo.
  if (process.env.TMUX) {
    try { boot.tmux_session = execSync("tmux display-message -p '#S'", { encoding: "utf8", timeout: 1000 }).trim() || null; }
    catch { /* sem tmux/erro => fica null */ }
  }
  let lastModel = null    // último modelID visto (mensagens do assistant)
  let capturedWin = null  // janela ativa no último prompt (X11)

  // Tools de PERGUNTA ao usuário: quando o agente chama uma destas, ele está
  // ESPERANDO uma resposta sua — é um "precisa de você" (🔴🔑), não um passo de
  // trabalho normal (verde). Frameworks autônomos (oh-my-openagent) perguntam
  // por TOOL, não pelo fluxo de permissão do OpenCode — então é aqui que o
  // vermelho realmente dispara nesses setups.
  const QUESTION_TOOLS = new Set(['ask', 'question', 'ask_user_question', 'askuserquestion'])
  const isQuestionTool = (name) => QUESTION_TOOLS.has(String(name || '').toLowerCase().replace(/[-\s]/g, '_'))

  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return {} }
  }

  // Escrita atômica (tmp + rename), merge-preserve de windowid/focus_url,
  // events rolante (últimos 50) — mesmo comportamento do traffic-hook.sh.
  // ID seguro p/ nome de arquivo (anti-path-traversal). Rejeita "../", espaços,
  // etc. — vem de payload externo.
  const SAFE_ID = /^[A-Za-z0-9._-]+$/

  const write = (sid, evt, tool) => {
    if (!sid || !SAFE_ID.test(sid)) return
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const file = path.join(STATE_DIR, `${sid}.json`)
      const ex = read(file)
      const now = Math.floor(Date.now() / 1000)
      const st = {
        schema_version: 2,
        agent: "opencode",
        session_id: sid,
        pid: process.pid,
        cwd: directory || process.cwd() || null,
        transcript_path: ex.transcript_path || null,
        model: lastModel || ex.model || null,
        term_program: boot.term_program,
        windowid: capturedWin || ex.windowid || boot.windowid || null,
        focus_url: boot.focus_url || ex.focus_url || null,
        tilix_id: boot.tilix_id || ex.tilix_id || null,
        zellij_session: boot.zellij_session,
        tmux_session: boot.tmux_session,
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

  // No prompt do usuário, a janela focada É o terminal da sessão (mesma
  // técnica do adapter Claude/Gemini) — desambigua Warp multi-janela.
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
        // tool de pergunta → 🔴❓ (espera resposta); as demais → verde (rodando)
        write(input && input.sessionID, isQuestionTool(tool) ? "Question" : "PreToolUse", tool)
      } catch {}
    },

    "tool.execute.after": async (input) => {
      try { write(input && input.sessionID, "PostToolUse", input && input.tool) } catch {}
    },

    // OpenCode chama este HOOK quando PEDE permissão (edit/bash/etc.). É o
    // caminho principal — dispara ANTES de o usuário responder. Marca 🔴🔑.
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
          // fallback p/ versões sem o hook chat.message
          if (info.role === "user") { await captureWindow(); write(sid, "UserPromptSubmit", null) }
          return
        }
        if (t === "session.idle") return write(sid, "Stop", null)
        // pediu permissão → 🔴🔑 (permission.asked é o evento; o hook
        // permission.ask acima é o caminho principal — os dois são idempotentes)
        if (t === "permission.ask" || t === "permission.asked") return write(sid, "PermissionRequest", null)
        // respondeu (allow/deny) → sai do vermelho; o próximo tool/idle ajusta a cor
        if (t === "permission.replied" || t === "permission.updated") return write(sid, "Stop", null)
        if (t === "session.error") return write(sid, "PostToolUseFailure", null)
        if (t === "session.deleted") return drop(sid)
      } catch {}
    },
  }
}
