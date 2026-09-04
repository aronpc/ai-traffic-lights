// Tests for the collection core (src/collect.js): findTranscript validates the
// peer's sid against path traversal (PR-32 #02). findTranscript reads
// process.env.HOME, so we mock HOME to a controlled tmp dir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findTranscript } = require('../src/collect.js');

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
