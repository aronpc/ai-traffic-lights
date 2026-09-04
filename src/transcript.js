// transcript.js — read the last N MESSAGES from a JSONL transcript (phase 3).
// Electron-free: fs only. Used by the /transcript endpoint (server) and by the
// "view prompt" panel (future). Reuses collect.findTranscript() to find the file.
//
// TWO gotchas (confirmed by research):
//  1. REVERSE reading from the end of the file, in CHUNKS (4-64KB) — never
//     loads the whole file (Codex transcripts reach ~2GB). Reads the last
//     ~2MB, which comfortably covers the last N messages.
//  2. One Claude Code assistant MESSAGE becomes SEVERAL JSONL lines
//     (incremental streaming blocks) with the SAME message.id → AGGREGATE by
//     message.id, never slice raw "last N lines" (176/227 msgs in a real
//     transcript).

const fs = require('fs');

const TAIL_BYTES = 2 * 1024 * 1024;   // reads the last 2MB (enough for dozens of msgs)
const CHUNK = 64 * 1024;              // reads in 64KB chunks (not 1 byte/syscall)
const MAX_MSG_CHARS = 4000;           // per-message truncation (payload under control)

// Reads the last ~maxBytes of the file in chunks (from the end) and returns
// complete LINES in chronological order. Does not load the whole file into memory.
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
    if (pos > 0) data = data.slice(data.indexOf('\n') + 1); // discards the 1st partial line
    return data.split('\n').filter(Boolean);
  } finally { fs.closeSync(fd); }
}

// Extracts {id, role, text, ts} from a transcript line object (Claude Code
// dialect: obj.message.{role,content,id}; content = string or array of blocks).
// Ignores tool_use/thinking/tool_result (not visible "prompt"). null if it is
// not a useful chat message.
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
    id: msg.id || null,   // PR-32 #15: null when there is no real id (Claude Code user msgs) — lastMessages treats each one as its own, instead of collapsing them all into one block
    role,
    text,
    ts: typeof obj.timestamp === 'string' ? obj.timestamp : null,
  };
}

// Last N messages (aggregating streaming blocks by message.id).
// Returns [{role, text, ts}] in chronological order.
function lastMessages(filePath, n = 20) {
  const lines = readTailLines(filePath);
  const byId = new Map();   // id -> {role, text, ts} (accumulates blocks of the same msg)
  const order = [];         // ids in order of appearance
  let seq = 0;              // synthetic key for msgs WITHOUT a real id (Claude Code user)
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const m = extractMessage(obj);
    if (!m) continue;
    // Only aggregates by a REAL message.id (assistant streaming blocks). Without
    // an id, each line is its OWN message (PR-32 #15: previously id='user'
    // collapsed all user prompts into a single item, breaking the view-prompt panel).
    const key = m.id || '__noid_' + (++seq);
    const prev = byId.get(key);
    if (prev) prev.text = prev.text + ' ' + m.text; // same msg.id = one more streaming block
    else { byId.set(key, { role: m.role, text: m.text, ts: m.ts }); order.push(key); }
  }
  return order.slice(-Math.max(1, n)).map((id) => byId.get(id)).filter(Boolean);
}

if (typeof module !== 'undefined') module.exports = { lastMessages, readTailLines, extractMessage };
