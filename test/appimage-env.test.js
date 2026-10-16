// Regression guard for the clobber that killed the installed AppImage FOUR
// times (2026-08-18, 2026-09-04, and twice on 2026-09-14): a terminal spawned by the overlay inherited
// APPIMAGE=…/AI-Traffic-Lights.AppImage, and its own AppImage updater wrote
// the new version over OUR file. The overlay then stopped starting — the
// desktop entry launched the other app instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { APPIMAGE_VARS, cleanEnv, leakedVars, withCleanEnv } = require('../src/appimage-env.js');

// The environ actually observed in the Warp process spawned by the overlay.
const CONTAMINADO = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/aron',
  APPIMAGE: '/home/aron/Applications/AI-Traffic-Lights.AppImage',
  APPDIR: '/tmp/.mount_AI-TraENKCIh',
  ARGV0: '/home/aron/Applications/AI-Traffic-Lights.AppImage',
  OWD: '/home/aron/Projetos',
};

test('cleanEnv: remove TODAS as vars do runtime do AppImage', () => {
  assert.deepEqual(leakedVars(cleanEnv(CONTAMINADO)), []);
});

test('cleanEnv: preserva o resto do ambiente intacto', () => {
  const out = cleanEnv(CONTAMINADO);
  assert.equal(out.PATH, '/usr/bin:/bin');
  assert.equal(out.HOME, '/home/aron');
});

test('cleanEnv: copia — não muta o env de origem', () => {
  const orig = { ...CONTAMINADO };
  cleanEnv(CONTAMINADO);
  // The overlay's OWN updater (src/ipc/update.js) depends on process.env.APPIMAGE
  // to know which file to replace; mutating in place would break it.
  assert.deepEqual(CONTAMINADO, orig);
});

test('cleanEnv: sem argumento cai em process.env e ainda sai limpo', () => {
  comProcessEnvContaminado(() => assert.deepEqual(leakedVars(cleanEnv()), []));
});

test('leakedVars: aponta exatamente o que vazou', () => {
  assert.deepEqual(leakedVars({ APPIMAGE: 'x', PATH: '/bin' }), ['APPIMAGE']);
  assert.deepEqual(leakedVars({ PATH: '/bin' }), []);
  assert.deepEqual(leakedVars(null), []);
  // A var whose VALUE is empty still leaks: the updater tests for presence.
  assert.deepEqual(leakedVars({ APPDIR: '' }), ['APPDIR']);
});

// --- the boundary itself: ipc/focus.js and ipc/launcher.js route every spawn
// through withCleanEnv, so exercising the wrapper is exercising what runs.
// These run with process.env CONTAMINATED on purpose: the default env comes
// from process.env, so a test over a clean one would pass even with the
// stripping removed — it would guard nothing.
function comProcessEnvContaminado(fn) {
  const saved = {};
  for (const k of APPIMAGE_VARS) saved[k] = process.env[k];
  Object.assign(process.env, {
    APPIMAGE: '/home/aron/Applications/AI-Traffic-Lights.AppImage',
    APPDIR: '/tmp/.mount_AI-TraENKCIh',
    ARGV0: '/home/aron/Applications/AI-Traffic-Lights.AppImage',
    OWD: '/home/aron/Projetos',
    APPIMAGE_EXTRACT_AND_RUN: '1',
  });
  try { fn(); } finally {
    for (const k of APPIMAGE_VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('withCleanEnv: o spawn recebe env SEM as vars do AppImage', () => {
  comProcessEnvContaminado(() => {
    const calls = [];
    const spawn = withCleanEnv((file, args, opts) => { calls.push({ file, args, opts }); });
    spawn('xdg-open', ['warp://session/abc'], { timeout: 2000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(leakedVars(calls[0].opts.env), []);
    // and the rest of the environment still reached the child
    assert.equal(calls[0].opts.env.PATH, process.env.PATH);
  });
});

test('withCleanEnv: repassa file/args/opts sem alterar', () => {
  const calls = [];
  const spawn = withCleanEnv((file, args, opts) => { calls.push({ file, args, opts }); });
  spawn('gdbus', ['call', '--session'], { timeout: 2000, detached: true });
  assert.equal(calls[0].file, 'gdbus');
  assert.deepEqual(calls[0].args, ['call', '--session']);
  assert.equal(calls[0].opts.timeout, 2000);
  assert.equal(calls[0].opts.detached, true);
});

test('withCleanEnv: funciona sem opts (a maioria das chamadas)', () => {
  comProcessEnvContaminado(() => {
    const calls = [];
    const spawn = withCleanEnv((file, args, opts) => { calls.push(opts); });
    spawn('wmctrl', ['-l', '-p']);
    assert.deepEqual(leakedVars(calls[0].env), []);
  });
});

test('withCleanEnv: env explícito do chamador vence (ptyEnv monta o seu)', () => {
  const calls = [];
  const spawn = withCleanEnv((file, args, opts) => { calls.push(opts); });
  spawn('tmux', ['attach'], { env: { PATH: '/bin', X: '1' } });
  assert.deepEqual(calls[0].env, { PATH: '/bin', X: '1' });
});

test('withCleanEnv: devolve o retorno da função embrulhada', () => {
  const exec = withCleanEnv(() => 'saída do ps');
  assert.equal(exec('ps', ['-p', '1']), 'saída do ps');
});

test('APPIMAGE_VARS cobre o runtime type-2 (regressão do clobber)', () => {
  // APPIMAGE is the one that causes the overwrite; the others come with it and
  // are equally meaningless to a child.
  for (const v of ['APPIMAGE', 'APPDIR', 'ARGV0']) assert.ok(APPIMAGE_VARS.includes(v), v);
});
