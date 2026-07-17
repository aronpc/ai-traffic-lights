const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validSessionId, shellQuote, desktopEscape, buildAttachCmd } = require('../src/validate.js');

test('validSessionId: aceita IDs seguros', () => {
  assert.equal(validSessionId('abc-123'), true);
  assert.equal(validSessionId('8fbb3b6e-ba84-4a0f-be3f-dcd4290936ac'), true);
  assert.equal(validSessionId('proc_42'), true);
  assert.equal(validSessionId('a.b'), true);
});

test('validSessionId: REJEITA path traversal e caracteres perigosos', () => {
  assert.equal(validSessionId('../foo'), false);
  assert.equal(validSessionId('../../etc/passwd'), false);
  assert.equal(validSessionId('a/b'), false, 'barra =Traversal real');
  assert.equal(validSessionId('a b'), false, 'espaço');
  assert.equal(validSessionId('a;b'), false);
  // ".." sozinho NÃO é traversal: vira o filename "..json" DENTRO do STATE_DIR
  // (sem '/' não há escape de diretório). Permitir é inofensivo e útil p/ IDs.
  assert.equal(validSessionId('..'), true);
  assert.equal(validSessionId(''), false, 'vazio');
  assert.equal(validSessionId(null), false);
  assert.equal(validSessionId(123), false);
  assert.equal(validSessionId('a'.repeat(300)), false, 'comprimento absurdo');
});

test('shellQuote: envolve caminho simples em aspas', () => {
  assert.equal(shellQuote('/home/user/bin/hook.sh'), "'/home/user/bin/hook.sh'");
});

test('shellQuote: escapa aspas simples internas', () => {
  assert.equal(shellQuote("/home/a b/c'd"), "'/home/a b/c'\\''d'");
});

test('shellQuote: path com espaço fica seguro p/ shell', () => {
  // o resultado, avaliado por bash, expande p/ um único argumento
  assert.equal(shellQuote('/home/my dir/x'), "'/home/my dir/x'");
});

test('desktopEscape: escapa espaço e reservados', () => {
  assert.equal(desktopEscape('/home/my dir/app'), '/home/my\\ dir/app');
  assert.equal(desktopEscape('a"b'), 'a\\"b');
  assert.equal(desktopEscape('a$b'), 'a\\$b');
});

test('desktopEscape: path sem reservados fica intacto', () => {
  assert.equal(desktopEscape('/usr/bin/electron'), '/usr/bin/electron');
});

// ---- buildAttachCmd (attach remoto tmux) ----
test('buildAttachCmd: local → tmux attach -t <name>', () => {
  assert.deepEqual(buildAttachCmd({ origin: 'local', tmux_session: 'work' }), { cmd: ['tmux', 'attach', '-t', 'work'] });
  assert.deepEqual(buildAttachCmd({ tmux_session: 'work' }), { cmd: ['tmux', 'attach', '-t', 'work'] }); // origin ausente = local
});

test('buildAttachCmd: remoto via tailscale ou ssh', () => {
  assert.deepEqual(buildAttachCmd({ origin: 'peer', tmux_session: 'work', host: 'notebook-hg', sshBin: 'tailscale' }),
    { cmd: ['tailscale', 'ssh', 'notebook-hg', '-t', 'tmux attach -t work'] });
  assert.deepEqual(buildAttachCmd({ origin: 'peer', tmux_session: 'work', host: '10.0.0.1:2222', sshBin: 'ssh' }),
    { cmd: ['ssh', '10.0.0.1:2222', '-t', 'tmux attach -t work'] });
});

test('buildAttachCmd: REJEITA injeção de shell em tmux_session e host', () => {
  // name malicioso (vem de peer) → nunca chega ao shell remoto
  assert.deepEqual(buildAttachCmd({ tmux_session: 'work; rm -rf /' }), { error: 'no_tmux' });
  assert.deepEqual(buildAttachCmd({ tmux_session: 'a b' }), { error: 'no_tmux' });
  assert.deepEqual(buildAttachCmd({ tmux_session: 'x`whoami`' }), { error: 'no_tmux' });
  assert.deepEqual(buildAttachCmd({ tmux_session: '$(reboot)' }), { error: 'no_tmux' });
  assert.deepEqual(buildAttachCmd({ tmux_session: '' }), { error: 'no_tmux' });
  // host malicioso ou ausente
  assert.deepEqual(buildAttachCmd({ origin: 'peer', tmux_session: 'work', host: 'peer; evil' }), { error: 'no_host' });
  assert.deepEqual(buildAttachCmd({ origin: 'peer', tmux_session: 'work', host: '' }), { error: 'no_host' });
});
