// transcript.js — ler as últimas N MENSAGENS de um transcript JSONL (fase 3).
// Electron-free: só fs. Usado pelo endpoint /transcript (servidor) e pelo painel
// "ver prompt" (futuro). Reusa collect.findTranscript() p/ achar o arquivo.
//
// DUAS armadilhas (confirmadas pela pesquisa):
//  1. Leitura REVERSA do fim do arquivo, em CHUNKS (4-64KB) — nunca carrega o
//     arquivo todo (transcripts do Codex chegam a ~2GB). Lê os últimos ~2MB,
//     que cobrem folgadamente as últimas N mensagens.
//  2. Uma MENSAGEM de assistant do Claude Code vira VÁRIAS linhas JSONL (blocos
//     incrementais de streaming) com o MESMO message.id → AGREGAR por message.id,
//     nunca fatiar "últimas N linhas" cruas (176/227 msgs num transcript real).

const fs = require('fs');

const TAIL_BYTES = 2 * 1024 * 1024;   // lê os últimos 2MB (chega p/ dezenas de msgs)
const CHUNK = 64 * 1024;              // Lê em chunks de 64KB (não 1 byte/syscall)
const MAX_MSG_CHARS = 4000;           // truncamento por mensagem (payload sob controle)

// Lê os últimos ~maxBytes do arquivo em chunks (do fim) e devolve as LINHAS
// completas em ordem cronológica. Não carrega o arquivo inteiro na memória.
function readTailLines(filePath, maxBytes = TAIL_BYTES) {
  let size;
  try { size = fs.statSync(filePath).size; } catch { return []; }
  if (size <= 0) return [];
  const want = Math.min(size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks = [];
    let pos = size, remaining = want;
    while (remaining > 0) {
      const len = Math.min(CHUNK, remaining);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      remaining -= len;
    }
    let data = Buffer.concat(chunks).toString('utf8');
    if (pos > 0) data = data.slice(data.indexOf('\n') + 1); // descarta 1ª linha parcial
    return data.split('\n').filter(Boolean);
  } finally { fs.closeSync(fd); }
}

// Extrai {id, role, text, ts} de um objeto-linha do transcript (dialeto Claude
// Code: obj.message.{role,content,id}; content = string ou array de blocos).
// Ignora tool_use/thinking/tool_result (não são "prompt" visível). null se não
// for uma mensagem de chat útil.
function extractMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const msg = obj.message || obj;
  const role = msg.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const content = msg.content;
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  let text = parts.join(' ').trim();
  if (!text) return null;
  if (text.length > MAX_MSG_CHARS) text = text.slice(0, MAX_MSG_CHARS) + '…';
  return {
    id: msg.id || null,   // PR-32 #15: null quando não há id real (msgs de user do Claude Code) — lastMessages trata cada uma como própria, em vez de colapsar todas num bloco
    role,
    text,
    ts: typeof obj.timestamp === 'string' ? obj.timestamp : null,
  };
}

// Últimas N mensagens (agregando os blocos de streaming pelo message.id).
// Devolve [{role, text, ts}] em ordem cronológica.
function lastMessages(filePath, n = 20) {
  const lines = readTailLines(filePath);
  const byId = new Map();   // id -> {role, text, ts} (acumula blocos do mesmo msg)
  const order = [];         // ids em ordem de aparição
  let seq = 0;              // chave sintética p/ msgs SEM id real (user do Claude Code)
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const m = extractMessage(obj);
    if (!m) continue;
    // Só agrega por message.id REAL (blocos de streaming do assistant). Sem id,
    // cada linha é uma mensagem PRÓPRIA (PR-32 #15: antes id='user' colapsava
    // todos os prompts do usuário num único item, quebrando o painel ver-prompt).
    const key = m.id || '__noid_' + (++seq);
    const prev = byId.get(key);
    if (prev) prev.text = prev.text + ' ' + m.text; // mesmo msg.id = bloco a mais do streaming
    else { byId.set(key, { role: m.role, text: m.text, ts: m.ts }); order.push(key); }
  }
  return order.slice(-Math.max(1, n)).map((id) => byId.get(id)).filter(Boolean);
}

if (typeof module !== 'undefined') module.exports = { lastMessages, readTailLines, extractMessage };
