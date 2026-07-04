const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TERMINALS, TERMINAL_ORDER, pickTerminal, terminalArgs } = require('../src/launcher.js');

test('pickTerminal: auto escolhe o 1º presente na ordem', () => {
  assert.equal(pickTerminal('auto', ['gnome-terminal', 'ghostty']), 'gnome-terminal');
  assert.equal(pickTerminal('auto', ['ghostty']), 'ghostty');
  assert.equal(pickTerminal('auto', ['tilix', 'gnome-terminal']), 'tilix'); // tilix tem prioridade
  assert.equal(pickTerminal('auto', []), null); // nenhum presente
  assert.equal(pickTerminal(undefined, ['tilix']), 'tilix'); // sem pref = auto
});

test('pickTerminal: pref manual válido vence (mesmo fora da ordem)', () => {
  assert.equal(pickTerminal('ghostty', ['tilix', 'ghostty']), 'ghostty');
  assert.equal(pickTerminal('custom', ['tilix']), 'custom');
});

test('pickTerminal: pref manual ausente no PATH cai no auto', () => {
  assert.equal(pickTerminal('ghostty', ['tilix']), 'tilix');
});

test('terminalArgs: tilix usa --working-directory + -e', () => {
  assert.deepEqual(terminalArgs('tilix', '/p', ['/bin/claude']), ['--working-directory=/p', '-e', '/bin/claude']);
});

test('terminalArgs: gnome-terminal usa --working-directory + --', () => {
  assert.deepEqual(terminalArgs('gnome-terminal', '/p', ['gemini']), ['--working-directory=/p', '--', 'gemini']);
});

test('terminalArgs: terminal desconhecido → null', () => {
  assert.equal(terminalArgs('xterm', '/p', ['claude']), null);
});

test('terminalArgs: agentCmd com args próprios é preservado', () => {
  assert.deepEqual(terminalArgs('ghostty', '/p', ['codex', '--flag']), ['--working-directory=/p', '-e', 'codex', '--flag']);
});

test('TERMINAL_ORDER: tilix vem antes de gnome-terminal e ghostty', () => {
  assert.equal(TERMINAL_ORDER[0], 'tilix');
});
