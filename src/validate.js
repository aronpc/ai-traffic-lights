// validate.js — sanitização nos limites de confiança (payload de hook, paths).
// Os adapters recebem JSON de agentes externos; o state file vira caminho de
// arquivo. Sem validação, um session_id malicioso ("../foo") vira path traversal.
// Funções PURAS, testadas.

// IDs seguros p/ nome de arquivo: letras, dígitos, . _ - (estilo xid UUID).
// Rejeita '/', '..', espaços e qualquer outra coisa — fallback: o adapter
// ignora o evento (não escreve) em vez de gravar fora do STATE_DIR.
function validSessionId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 256 && /^[A-Za-z0-9._-]+$/.test(s);
}

// Shell-quote de um caminho p/ uso em command de hook (settings.json).
// Envolve em aspas simples e escapa ' internas. Previne quebra/interpretação
// se XDG_DATA_HOME ou HOME tiverem espaços ou metacaracteres.
function shellQuote(s) {
  if (typeof s !== 'string') return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Escape de string p/ o campo Exec de um .desktop (Desktop Entry Spec).
// Reservados que precisam de backslash: espaço e `" ` $ \ ; e outros de shell.
function desktopEscape(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\\$" `'*?();<>|&#~]/g, (c) => '\\' + c);
}

if (typeof module !== 'undefined') module.exports = { validSessionId, shellQuote, desktopEscape, buildAttachCmd };

// Monta o argv do "attach remoto tmux" (vivo, compartilhado). Sanitiza
// tmux_session ([A-Za-z0-9._-]) e host (hostname/IP[:porta]) — ambos vêm de
// config/peer e entram num COMANDO SHELL remoto ('ssh peer -t "..."' ), então
// sem isto um peer malicioso poderia injetar shell. Retorna {cmd} ou
// {error:'no_tmux'|'no_host'}. sshBin='tailscale'|'ssh'.
function buildAttachCmd({ origin, tmux_session, host, sshBin }) {
  if (!tmux_session || !/^[A-Za-z0-9._-]+$/.test(tmux_session)) return { error: 'no_tmux' };
  if (!origin || origin === 'local') return { cmd: ['tmux', 'attach', '-t', tmux_session] };
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host)) return { error: 'no_host' };
  const remote = 'tmux attach -t ' + tmux_session;   // name sanitizado → seguro no shell remoto
  return { cmd: sshBin === 'tailscale' ? ['tailscale', 'ssh', host, '-t', remote] : ['ssh', host, '-t', remote] };
}
