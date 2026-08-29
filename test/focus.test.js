// Testes da lógica pura de click-to-focus (issue #1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWindowId, pickWindow, tabChannel, tmuxTarget, tmuxClientPid,
  parseEnviron, focusFailure, isRemoteSession,
} = require('../src/focus.js');

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

test('#1 tabChannel: Warp provado → xdg-open da focus_url', () => {
  assert.deepEqual(
    tabChannel({ focus_url: 'warp://session/abc', terminal: 'warp' }),
    { kind: 'warp', value: 'warp://session/abc' },
  );
});

test('#1 tabChannel: Tilix provado → gdbus com o tilix_id', () => {
  assert.deepEqual(
    tabChannel({ tilix_id: '5b95bf87-uuid', terminal: 'tilix' }),
    { kind: 'tilix', value: '5b95bf87-uuid' },
  );
});

test('tabChannel: iTerm2 provado → só o uuid do ITERM_SESSION_ID', () => {
  assert.deepEqual(
    tabChannel({ iterm_id: 'w0t0p0:1E0A8E10-3EA8-4FCA', terminal: 'iterm' }),
    { kind: 'iterm', value: '1E0A8E10-3EA8-4FCA' },
  );
});

// O bug relatado: um WARP_FOCUS_URL congelado no environ de um tmux server que
// nasceu dentro do Warp vaza pra todo pane. Reancorar no client NÃO resolve
// sozinho — quando o client está no Tilix ele não tem focus_url nenhum, e um
// `live.focus_url || t.focus_url` deixaria o fantasma passar. A prova resolve.
test('tabChannel: focus_url fantasma, mas o terminal provado é Tilix → NÃO chama o Warp', () => {
  const contaminado = { focus_url: 'warp://session/0e03aa52', tilix_id: 'uuid-real', terminal: 'tilix' };
  assert.deepEqual(tabChannel(contaminado), { kind: 'tilix', value: 'uuid-real' });
});

test('tabChannel: sem terminal provado → null (degrada pra só levantar a janela)', () => {
  assert.equal(tabChannel({ focus_url: 'warp://session/x', terminal: null }), null);
  assert.equal(tabChannel({ tilix_id: 'y' }), null);
});

test('tabChannel: terminal sem canal (gnome, kitty…) → null', () => {
  assert.equal(tabChannel({ terminal: 'gnome', focus_url: 'warp://s/x' }), null);
  assert.equal(tabChannel({ terminal: 'kitty', tilix_id: 'y' }), null);
});

const SEM_HINTS = { focus_url: null, tilix_id: null, iterm_id: null, tmux_pane: null };

test('#1 parseEnviron: extrai os hints de foco do environ (NUL-sep)', () => {
  assert.equal(parseEnviron('PATH=/bin\0WARP_FOCUS_URL=warp://session/xyz\0HOME=/h\0').focus_url, 'warp://session/xyz');
  assert.equal(parseEnviron('TERM=xterm\0TILIX_ID=b6c1585a-uuid\0USER=aron\0').tilix_id, 'b6c1585a-uuid');
  assert.equal(parseEnviron('ITERM_SESSION_ID=w0t0p0:UUID\0').iterm_id, 'w0t0p0:UUID');
  assert.equal(parseEnviron('TERM=xterm\0TMUX_PANE=%3\0TMUX=/tmp/tmux-1000/default,42,0\0').tmux_pane, '%3');
});

test('#1 parseEnviron: vazio/null → todos os hints nulos, nunca lança', () => {
  for (const entrada of ['', null, undefined]) assert.deepEqual(parseEnviron(entrada), SEM_HINTS);
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

test('#1 tabChannel: sem canal e entradas degeneradas → null', () => {
  assert.equal(tabChannel({}), null);
  assert.equal(tabChannel(null), null);
  // focus_url não-warp é ignorado (allowlist de esquema), mesmo com Warp provado
  assert.equal(tabChannel({ focus_url: 'http://evil', terminal: 'warp' }), null);
});

// ---- sessão de outra máquina (sync P2P) ----
// O pid de um peer é de OUTRO kernel: interpretá-lo aqui focaria um processo
// local homônimo — a mesma classe de erro do windowid reciclado, um nível acima.

test('isRemoteSession: origin de peer → true; local/ausente → false', () => {
  assert.equal(isRemoteSession({ origin: 'thinkpad' }), true);
  assert.equal(isRemoteSession({ origin: 'local' }), false);
  assert.equal(isRemoteSession({}), false);
  assert.equal(isRemoteSession(null), false);
});

test('focusFailure: sessão remota → remote, mesmo que algo tenha sido levantado', () => {
  assert.equal(focusFailure({ origin: 'thinkpad', raised: true, hasTab: true }), 'remote');
});

// ---- desfecho do clique ----

test('focusFailure: levantou a janela ou alcançou a aba → null (teve efeito)', () => {
  assert.equal(focusFailure({ wayland: true, raised: true, hasTab: false }), null);
  assert.equal(focusFailure({ wayland: true, raised: false, hasTab: true }), null);
});

test('focusFailure: tmux sem client anexado → detached (mais específico que os outros)', () => {
  assert.equal(focusFailure({ wayland: false, raised: false, hasTab: false, detached: true }), 'detached');
  assert.equal(focusFailure({ wayland: true, raised: false, hasTab: false, detached: true }), 'detached');
});

test('focusFailure: Wayland sem canal → wayland', () => {
  assert.equal(focusFailure({ wayland: true, raised: false, hasTab: false }), 'wayland');
});

test('focusFailure: X11/macOS sem janela e sem canal → nowindow (antes era silêncio)', () => {
  assert.equal(focusFailure({ wayland: false, raised: false, hasTab: false }), 'nowindow');
});

test('focusFailure: null / state vazio → nunca lança', () => {
  assert.equal(focusFailure(null), null);
  assert.equal(focusFailure({}), 'nowindow');
});
