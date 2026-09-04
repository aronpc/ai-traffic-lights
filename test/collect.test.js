// Tests for the collection core (src/collect.js): findTranscript validates the
// peer's sid against path traversal (PR-32 #02). findTranscript reads
// process.env.HOME, so we mock HOME to a controlled tmp dir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findTranscript, parseStatFields, acceptedProc } = require('../src/collect.js');

const realHome = process.env.HOME;
function withHome(h, fn) { process.env.HOME = h; try { return fn(); } finally { process.env.HOME = realHome; } }

test('findTranscript: session_id válido (UUID) é encontrado', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ft-'));
  const proj = path.join(tmp, '.claude/projects/myproj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'b955acd8-9c2e-41d2-91d9-96c54177403a.jsonl'), '{}');
  const got = withHome(tmp, () => findTranscript('b955acd8-9c2e-41d2-91d9-96c54177403a'));
  assert.equal(got, path.join(proj, 'b955acd8-9c2e-41d2-91d9-96c54177403a.jsonl'));
});

test('findTranscript: path traversal (../ / .. / vazio) é rejeitado → null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ft-'));
  fs.mkdirSync(path.join(tmp, '.claude/projects/p'), { recursive: true });
  // traps the traversal would reach WITHOUT validation:
  fs.writeFileSync(path.join(tmp, '.claude/secret.jsonl'), 'X');        // ../../secret from projects/p
  fs.writeFileSync(path.join(tmp, 'secret.jsonl'), 'Y');                 // ../../../secret
  for (const bad of ['../../secret', '../../../secret', '../secret', '..', '/', 'foo/bar', 'a b', '', null, undefined]) {
    const got = withHome(tmp, () => findTranscript(bad));
    assert.equal(got, null, 'deveria rejeitar: ' + JSON.stringify(bad));
  }
});

// ---- extraConfigDirs (CodeRabbit PR #63): NAMED profile transcripts ----
// projectsRoots() only knows THIS process's config dir — a session from a
// named profile (dd-claude, CLAUDE_CONFIG_DIR=~/.prof-a) has its transcript
// under ~/.prof-a/projects/... and would never be found without the extras.
test('findTranscript: acha o transcript em PERFIL NOMEADO via extraConfigDirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ft-'));
  const sid = '3f6d8c52-9a41-4b0e-8f2a-5c6d7e8f9a02';
  // named profile dir: <prof>/projects/<proj>/<sid>.jsonl (same layout as ~/.claude/projects)
  const profProj = path.join(tmp, '.prof-a', 'projects', 'myproj');
  fs.mkdirSync(profProj, { recursive: true });
  fs.writeFileSync(path.join(profProj, sid + '.jsonl'), '{}');
  const expected = path.join(profProj, sid + '.jsonl');

  // without the extras: not found (the default roots don't know .prof-a)
  assert.equal(withHome(tmp, () => findTranscript(sid)), null, 'sem extras → null (regression check)');
  // with the profile CONFIG dir: found under <dir>/projects
  assert.equal(withHome(tmp, () => findTranscript(sid, [path.join(tmp, '.prof-a')])), expected);
  // trailing slash on the dir is normalized by path.join
  assert.equal(withHome(tmp, () => findTranscript(sid, [path.join(tmp, '.prof-a') + '/'])), expected);
});

test('findTranscript: extraConfigDirs não duplica nem quebra com dirs inexistentes/inválidos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ft-'));
  const sid = '4f6d8c52-9a41-4b0e-8f2a-5c6d7e8f9a03';
  const proj = path.join(tmp, '.claude/projects/myproj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, sid + '.jsonl'), '{}');
  const got = withHome(tmp, () => findTranscript(sid, [
    '/nonexistent-profile-dir',   // unreadable root → skipped silently
    null,                          // junk entry → skipped
  ]));
  assert.equal(got, path.join(proj, sid + '.jsonl'), 'standard root still wins with junk extras');
});

// ---- headless discovery: the controlling-terminal signal (pure gates) ----
test('parseStatFields: ppid e tty_nr corretos mesmo com comm exótico (espaço/parêntese)', () => {
  // /proc stat: "pid (comm) state ppid pgrp session tty_nr …". comm pode ter
  // espaço E parêntese — os campos só são confiáveis depois do ÚLTIMO ')'.
  // Medido ao vivo: headless real (tty_nr=0) e sessão attachada (tty_nr=34818).
  assert.deepEqual(
    parseStatFields('1483 (cla (de)) S 1245 1483 1483 0 -1 4194560 12345 0 0 0 1 2 3'),
    { ppid: 1245, ttyNr: 0 },
  );
  assert.deepEqual(
    parseStatFields('1026 (claude) S 1026 1026 1026 34818 -1 4194560 999 0 0 0 1 2 3'),
    { ppid: 1026, ttyNr: 34818 },
  );
  assert.equal(parseStatFields('junk sem parenteses'), null);
  assert.equal(parseStatFields(null), null);
});

test('acceptedProc: tty_nr=0 é headless (tty vence sobre o pai); pai shell+tty = attached; resto fora', () => {
  assert.deepEqual(acceptedProc('zsh', 34818), { headless: false }, 'attachado clássico (pai shell, com tty)');
  assert.deepEqual(acceptedProc('zsh', 0), { headless: true }, 'claude -p via Bash tool: pai é shell, mas sem tty');
  assert.deepEqual(acceptedProc('bakeoff', 0), { headless: true }, 'SDK/nhup: sem pai shell e sem tty');
  assert.equal(acceptedProc('node', 1), null, 'pai não-shell com tty segue fora (daemon/MCP — comportamento preservado)');
});
