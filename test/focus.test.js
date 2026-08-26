// Testes da lógica pura de click-to-focus (issue #1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWindowId, pickWindow, tabChannel, tmuxTarget, tmuxClientPid, parseEnviron, isFocusUnsupported } = require('../src/focus.js');

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

// tmuxClientPid: sob tmux o PID do agente não alcança o terminal (o server é
// daemon reparentado pro init). Quem é filho do emulador é o CLIENT anexado à
// sessão do pane — este é o elo usado pro raise e pro focus_url por-aba.
const panes = [
  { pane: '%28', session: '29' },
  { pane: '%41', session: '41' },
  { pane: '%37', session: '37' },
];
const clients = [
  { session: '29', pid: 1209078, activity: 100 },
  { session: '41', pid: 254966, activity: 200 },
];

test('tmuxClientPid: pane → sessão → client anexado', () => {
  assert.equal(tmuxClientPid('%41', panes, clients), 254966);
  assert.equal(tmuxClientPid('%28', panes, clients), 1209078);
});

test('tmuxClientPid: sessão detached (sem client) → null', () => {
  // %37 está na sessão 37, que ninguém anexou → nada a focar
  assert.equal(tmuxClientPid('%37', panes, clients), null);
});

test('tmuxClientPid: N clients na mesma sessão → o de activity mais recente', () => {
  const multi = [
    { session: '41', pid: 111, activity: 500 },
    { session: '41', pid: 222, activity: 900 },   // mais recente
    { session: '41', pid: 333, activity: 700 },
  ];
  assert.equal(tmuxClientPid('%41', panes, multi), 222);
});

test('tmuxClientPid: pane desconhecido / entradas inválidas → null', () => {
  assert.equal(tmuxClientPid('%99', panes, clients), null);
  assert.equal(tmuxClientPid(null, panes, clients), null);
  assert.equal(tmuxClientPid('%41', null, clients), null);
  assert.equal(tmuxClientPid('%41', panes, null), null);
  assert.equal(tmuxClientPid('%41', panes, []), null);
  // pid inválido (parse falhou) não vira alvo
  assert.equal(tmuxClientPid('%41', panes, [{ session: '41', pid: NaN, activity: 1 }]), null);
});

test('#1 tabChannel: sem canal (gnome-terminal etc.) → null', () => {
  assert.equal(tabChannel({ term_program: 'gnome-terminal' }), null);
  assert.equal(tabChannel({}), null);
  assert.equal(tabChannel(null), null);
  // focus_url não-warp é ignorado (allowlist de esquema)
  assert.equal(tabChannel({ focus_url: 'http://evil' }), null);
});

// isFocusUnsupported: o clique virou no-op? Sem raise + sem canal de aba. A
// plataforma não muda a pergunta — antes o gate exigia `wayland: true` e por
// isso deixava o X11 mudo, mesmo quando o clique não fazia efeito nenhum.
test('isFocusUnsupported: Wayland + sem raise + sem canal → true (gnome-terminal nativo)', () => {
  assert.equal(isFocusUnsupported({ wayland: true, raised: false, hasTab: false }), true);
});

test('isFocusUnsupported: X11 sem raise e sem canal TAMBÉM dispara', () => {
  // era `assert.equal(..., false)`: a asserção antiga codificava a premissa de
  // que no X11 o wmctrl sempre alcança a janela. Não alcança quando a árvore de
  // processos passa por um multiplexador, nem quando o Mutter recusa a ativação.
  assert.equal(isFocusUnsupported({ wayland: false, raised: false, hasTab: false }), true);
});

test('isFocusUnsupported: raiseou a janela → false (teve efeito)', () => {
  assert.equal(isFocusUnsupported({ wayland: true, raised: true, hasTab: false }), false);
});

test('isFocusUnsupported: Warp/Tilix têm canal de aba → false mesmo sem raise', () => {
  assert.equal(isFocusUnsupported({ wayland: true, raised: false, hasTab: true }), false);
});

test('isFocusUnsupported: sem state → false; state vazio → true (nada teve efeito)', () => {
  assert.equal(isFocusUnsupported(null), false);      // nada a dizer
  assert.equal(isFocusUnsupported(undefined), false);
  assert.equal(isFocusUnsupported({}), true);         // nem raise nem aba
});
