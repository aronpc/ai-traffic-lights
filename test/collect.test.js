// Testes do core de coleta (src/collect.js): findTranscript valida sid do peer
// contra path traversal (PR-32 #02). findTranscript lê process.env.HOME, então
// mockamos HOME para um tmp controlado.
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
  // armadilhas que o traversal alcançaria SEM validação:
  fs.writeFileSync(path.join(tmp, '.claude/secret.jsonl'), 'X');        // ../../secret a partir de projects/p
  fs.writeFileSync(path.join(tmp, 'secret.jsonl'), 'Y');                 // ../../../secret
  for (const bad of ['../../secret', '../../../secret', '../secret', '..', '/', 'foo/bar', 'a b', '', null, undefined]) {
    const got = withHome(tmp, () => findTranscript(bad));
    assert.equal(got, null, 'deveria rejeitar: ' + JSON.stringify(bad));
  }
});
