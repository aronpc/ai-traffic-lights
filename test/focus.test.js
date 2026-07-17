// Testes da lógica pura de click-to-focus (issue #1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWindowId, pickWindow, tabChannel, tmuxTarget, parseEnviron, isFocusUnsupported } = require('../src/focus.js');

test('parseWindowId: hex, decimal, inválidos', () => {
  assert.equal(parseWindowId('0x06a00007'), 0x06a00007);
  assert.equal(parseWindowId('50332154'), 50332154);
  assert.equal(parseWindowId(50332154), 50332154);
  assert.equal(parseWindowId(null), null);
  assert.equal(parseWindowId(''), null);
  assert.equal(parseWindowId('lixo'), null);
});

const wins = [
  { id: '0x0a', idNum: 0x0a, pid: 100 }, // outra app
  { id: '0x0b', idNum: 0x0b, pid: 200 }, // terminal da sessão
  { id: '0x0c', idNum: 0x0c, pid: 200 }, // 2ª janela do mesmo terminal
];

test('#1/H2 pickWindow: windowid válido (pid da sessão) é usado', () => {
  assert.equal(pickWindow('0x0b', wins, new Set([200, 999])), '0x0b');
});

test('#1/H2 pickWindow: windowid obsoleto/reciclado (pid alheio) é DESCARTADO', () => {
  // 0x0a existe mas pertence a outra app (pid 100 ∉ ancestrais) → não ativa
  // essa janela; cai na 1ª janela da sessão (pid 200).
  assert.equal(pickWindow('0x0a', wins, new Set([200])), '0x0b');
});

test('#1/H2 pickWindow: windowid ausente → 1ª janela da sessão', () => {
  assert.equal(pickWindow(null, wins, new Set([200])), '0x0b');
});

test('#1/H2 pickWindow: windowid inexistente na lista → fallback por pid', () => {
  assert.equal(pickWindow('0xff', wins, new Set([200])), '0x0b');
});

test('#1/H2 pickWindow: nenhuma janela da sessão → null (nada a ativar)', () => {
  assert.equal(pickWindow('0xff', wins, new Set([777])), null);
});

test('#1 tabChannel: Warp → xdg-open da focus_url', () => {
  assert.deepEqual(
    tabChannel({ focus_url: 'warp://session/abc', term_program: 'WarpTerminal' }),
    { kind: 'warp', value: 'warp://session/abc' },
  );
});

test('#1 tabChannel: Tilix → gdbus com o tilix_id', () => {
  assert.deepEqual(
    tabChannel({ tilix_id: '5b95bf87-uuid', term_program: 'tilix' }),
    { kind: 'tilix', value: '5b95bf87-uuid' },
  );
});

test('#1 tabChannel: focus_url tem precedência sobre tilix_id', () => {
  assert.deepEqual(
    tabChannel({ focus_url: 'warp://session/x', tilix_id: 'y' }),
    { kind: 'warp', value: 'warp://session/x' },
  );
});

test('#1 parseEnviron: extrai WARP_FOCUS_URL, TILIX_ID e TMUX_PANE do environ (NUL-sep)', () => {
  const warp = 'PATH=/bin\0WARP_FOCUS_URL=warp://session/xyz\0HOME=/h\0';
  assert.deepEqual(parseEnviron(warp), { focus_url: 'warp://session/xyz', tilix_id: null, tmux_pane: null });
  const tilix = 'TERM=xterm\0TILIX_ID=b6c1585a-uuid\0USER=aron\0';
  assert.deepEqual(parseEnviron(tilix), { focus_url: null, tilix_id: 'b6c1585a-uuid', tmux_pane: null });
  const tmux = 'TERM=xterm\0TMUX_PANE=%3\0TMUX=/tmp/tmux-1000/default,42,0\0';
  assert.deepEqual(parseEnviron(tmux), { focus_url: null, tilix_id: null, tmux_pane: '%3' });
  assert.deepEqual(parseEnviron(''), { focus_url: null, tilix_id: null, tmux_pane: null });
  assert.deepEqual(parseEnviron(null), { focus_url: null, tilix_id: null, tmux_pane: null });
  // valor com '=' interno preservado; chave sem '=' ignorada
  assert.equal(parseEnviron('WARP_FOCUS_URL=warp://s/a=b\0BARE').focus_url, 'warp://s/a=b');
});

test('tmuxTarget: pane id válido (%N) é retornado', () => {
  assert.equal(tmuxTarget({ tmux_pane: '%3' }), '%3');
  assert.equal(tmuxTarget({ tmux_pane: '%12' }), '%12');
});

test('tmuxTarget: sem tmux_pane → null', () => {
  assert.equal(tmuxTarget({}), null);
  assert.equal(tmuxTarget(null), null);
  assert.equal(tmuxTarget({ tmux_pane: '' }), null);
});

test('tmuxTarget: valor fora do formato %N é REJEITADO (vira argumento do tmux)', () => {
  assert.equal(tmuxTarget({ tmux_pane: '3' }), null);             // sem o %
  assert.equal(tmuxTarget({ tmux_pane: '%abc' }), null);          // não-numérico
  assert.equal(tmuxTarget({ tmux_pane: '%3 ; rm -rf /' }), null); // tentativa de injeção
  assert.equal(tmuxTarget({ tmux_pane: '$(evil)' }), null);
});

test('#1 tabChannel: sem canal (gnome-terminal etc.) → null', () => {
  assert.equal(tabChannel({ term_program: 'gnome-terminal' }), null);
  assert.equal(tabChannel({}), null);
  assert.equal(tabChannel(null), null);
  // focus_url não-warp é ignorado (allowlist de esquema)
  assert.equal(tabChannel({ focus_url: 'http://evil' }), null);
});

// isFocusUnsupported: o clique virou no-op? Wayland + sem raise (wmctrl cego
// pra apps Wayland-nativos) + sem canal de aba. (issue: foco do terminal
// padrão do Ubuntu no Wayland — gnome-terminal não é alcançável.)
test('isFocusUnsupported: Wayland + sem raise + sem canal → true (gnome-terminal nativo)', () => {
  assert.equal(isFocusUnsupported({ wayland: true, raised: false, hasTab: false }), true);
});

test('isFocusUnsupported: X11 nunca dispara (wmctrl alcança a janela)', () => {
  assert.equal(isFocusUnsupported({ wayland: false, raised: false, hasTab: false }), false);
});

test('isFocusUnsupported: raiseou a janela → false (teve efeito)', () => {
  assert.equal(isFocusUnsupported({ wayland: true, raised: true, hasTab: false }), false);
});

test('isFocusUnsupported: Warp/Tilix têm canal de aba → false mesmo sem raise', () => {
  assert.equal(isFocusUnsupported({ wayland: true, raised: false, hasTab: true }), false);
});

test('isFocusUnsupported: null / state vazio → false', () => {
  assert.equal(isFocusUnsupported(null), false);
  assert.equal(isFocusUnsupported({}), false);
});
