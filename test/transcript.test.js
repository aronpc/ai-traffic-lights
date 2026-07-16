// Testes do leitor de transcripts (src/transcript.js): leitura reversa em chunks,
// agregação por message.id (streaming multi-linha) e último-N mensagens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastMessages, readTailLines, extractMessage } = require('../src/transcript.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-tr-'));
function writeFile(name, content) { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; }

// ---- extractMessage ----
test('extractMessage: user com content string', () => {
  assert.deepEqual(extractMessage({ message: { role: 'user', content: 'olá', id: 'u1' } }),
    { id: 'u1', role: 'user', text: 'olá', ts: null });
});

test('extractMessage: assistant com array de blocos pega só .text (ignora thinking/tool_use)', () => {
  const m = extractMessage({ message: { role: 'assistant', id: 'a1', content: [
    { type: 'thinking', thinking: 'segredo' },
    { type: 'text', text: 'resposta' },
    { type: 'tool_use', name: 'bash' },
  ] }, timestamp: '2026-07-16T10:00:00Z' });
  assert.equal(m.role, 'assistant');
  assert.equal(m.text, 'resposta');
  assert.equal(m.ts, '2026-07-16T10:00:00Z');
});

test('extractMessage: não-mensagem (system/sumário) → null', () => {
  assert.equal(extractMessage({ type: 'summary', summary: 'x' }), null);
  assert.equal(extractMessage(null), null);
  assert.equal(extractMessage({ message: { role: 'system', content: 'y' } }), null);
});

test('extractMessage: trunca mensagem enorme', () => {
  const big = 'x'.repeat(5000);
  const m = extractMessage({ message: { role: 'user', id: 'u', content: big } });
  assert.ok(m.text.length < 5000 && m.text.endsWith('…'));
});

// ---- readTailLines: lê do fim, não o arquivo todo ----
test('readTailLines: devolve linhas em ordem cronológica', () => {
  const p = writeFile('a.jsonl', Array.from({ length: 10 }, (_, i) => `{"i":${i}}`).join('\n'));
  const lines = readTailLines(p, 4096);
  assert.deepEqual(lines.map((l) => JSON.parse(l).i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('readTailLines: respeita maxBytes (descarta linha parcial do corte)', () => {
  const p = writeFile('b.jsonl', Array.from({ length: 50 }, (_, i) => `{"i":${i}}`).join('\n'));
  const lines = readTailLines(p, 30);   // pouquíssimos bytes → só o fim, sem linha partida
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
  assert.ok(JSON.parse(lines[lines.length - 1]).i === 49, 'última linha é a 49');
});

test('readTailLines: arquivo inexistente/vazio → []', () => {
  assert.deepEqual(readTailLines(path.join(tmp, 'nope.jsonl')), []);
  const empty = writeFile('empty.jsonl', '');
  assert.deepEqual(readTailLines(empty), []);
});

// ---- lastMessages: agregação por message.id (streaming) + último-N ----
test('lastMessages: agrega blocos do MESMO message.id numa mensagem', () => {
  // Uma msg assistant "a1" streaming em 3 linhas + 1 user.
  const p = writeFile('c.jsonl', [
    JSON.stringify({ message: { role: 'user', id: 'u1', content: 'pergunta' } }),
    JSON.stringify({ message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'r1 ' }] } }),
    JSON.stringify({ message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'r2 ' }] } }),
    JSON.stringify({ message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'r3' }] } }),
  ].join('\n'));
  const msgs = lastMessages(p, 20);
  assert.equal(msgs.length, 2, '2 mensagens (1 user + 1 assistant agregada)');
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'pergunta');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].text, 'r1 r2 r3', '3 blocos concatenados');
});

test('lastMessages: respeita N (últimas N mensagens em ordem)', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ message: { role: 'user', id: 'u' + i, content: 'm' + i } }));
  const p = writeFile('d.jsonl', lines.join('\n'));
  const msgs = lastMessages(p, 3);
  assert.deepEqual(msgs.map((m) => m.text), ['m7', 'm8', 'm9']);
});

test('lastMessages: sem mensagens de chat → []', () => {
  const p = writeFile('e.jsonl', Array.from({ length: 5 }, () => '{"type":"system","content":"x"}').join('\n'));
  assert.deepEqual(lastMessages(p, 20), []);
});
