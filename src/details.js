// details.js — montagem do card de detalhes da sessão + bootstrap da JANELA
// solta (details.html). Extraído do renderer.js quando o painel deixou de ser
// modal bloqueante do overlay (#59): agora vive numa BrowserWindow própria,
// não bloqueia a lista e atualiza AO VIVO (o main empurra a sessão a cada
// refresh). Módulo duplo browser/Node (padrão fuzzy.js) — os testes carregam
// num vm com DOM mock, sem o renderer inteiro.
//
// Estrutura: mountDetails(root, s, ctx) preenche .dt-title e monta .dt-body
// (mesma estrutura de seções/rows de antes); initDetailsWindow(api) é o
// bootstrap da página: escuta o push 'details-data' do main, monta, e liga
// Esc/× ao IPC 'details-close'.

function basename(p) {
  return String(p || '').replace(/\/+$/, '').split('/').pop() || '';
}

// Label da sessão (mesma lógica da linha do overlay: apelido > pasta > agente·pid).
// Recebe o map de aliases — quem chama é dono do estado.
function labelFor(s, aliases) {
  const alias = aliases[aliasKey(s)];
  if (alias) return alias;
  if (s.cwd) return basename(s.cwd);
  return (AGENTS[agentOf(s)] || { label: agentOf(s) }).label.toLowerCase() + ' · ' + s.pid;
}

function dtSec(title) {
  const h = document.createElement('div');
  h.className = 'dt-sec';
  h.textContent = title;
  return h;
}

function dtRow(label, value, copyText, T, copy) {
  const row = document.createElement('div');
  row.className = 'dt-row';
  const k = document.createElement('span');
  k.className = 'dt-k';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'dt-v';
  v.textContent = value;
  row.append(k, v);
  if (copyText && copy) {
    const b = document.createElement('button');
    b.className = 'dt-copy';
    b.textContent = T('dt_copy');
    b.addEventListener('click', (e) => { e.stopPropagation(); copy(copyText); });
    row.append(b);
  }
  return row;
}

// Monta o card inteiro dentro de `root` (uma .dt-card com .dt-title/.dt-body —
// o HTML da details.html traz o esqueleto). ctx = {T, copy, aliases, readAt,
// agentLabel}: T/copy/aliases vêm da página; readAt (epoch s, ou 0) é a marca
// de leitura vigente que o main manda junto no push; agentLabel resolve o nome
// amigável do agente.
function mountDetails(root, s, ctx) {
  const T = ctx.T;
  root.querySelector('.dt-title').textContent = labelFor(s, ctx.aliases);
  const body = root.querySelector('.dt-body');
  body.replaceChildren();

  // — Sessão —
  body.append(dtSec(T('dt_session')));
  body.append(dtRow(T('dt_agent'), ctx.agentLabel ? ctx.agentLabel(s) : agentOf(s)));
  body.append(dtRow(T('dt_sid'), s.session_id || '—', s.session_id, T, ctx.copy));
  const alias = ctx.aliases[aliasKey(s)];
  if (alias) body.append(dtRow(T('dt_alias'), alias));
  if (s.model) body.append(dtRow(T('dt_model'), s.model));
  // Conta Claude da sessão (#58): rótulo anotado no main a partir do
  // CLAUDE_CONFIG_DIR do environ do pid — distingue perfis dd-claude com
  // autenticações diferentes rodando ao mesmo tempo. Remota traz o rótulo
  // da conta DA ORIGEM. Sem rótulo resolvido = linha ausente.
  if (s.account) body.append(dtRow(T('dt_account'), s.account));
  if (s.pid) body.append(dtRow(T('dt_pid'), String(s.pid)));

  // — Contexto — (windowid é LOCAL_ONLY: na remota o campo nem existe)
  body.append(dtSec(T('dt_context')));
  if (s.cwd) body.append(dtRow(T('dt_cwd'), s.cwd, s.cwd, T, ctx.copy));
  if (s.term_program && s.term_program !== 'terminal') body.append(dtRow(T('dt_term'), s.term_program));
  if (s.tmux_session) body.append(dtRow(T('dt_tmux'), s.tmux_session));
  body.append(dtRow(T('dt_origin'), s.origin || 'local'));
  if (s.windowid) body.append(dtRow(T('dt_window'), String(s.windowid)));

  // — Atividade —
  body.append(dtSec(T('dt_activity')));
  const age = ageText(Math.floor(Date.now() / 1000), s.last_event_ts);
  body.append(dtRow(T('dt_last_event'), (s.last_event || '—') + (age ? ' · ' + age : '')));
  if (s.last_tool) body.append(dtRow(T('dt_last_tool'), s.last_tool));
  if (s.notification_type) body.append(dtRow(T('dt_notification'), s.notification_type));
  if (ctx.readAt) body.append(dtRow(T('dt_read_until'), new Date(ctx.readAt * 1000).toLocaleTimeString()));

  // — Linha do tempo — events[] rolling de 50 do hook; COLAPSADA por padrão
  // (50 linhas despejadas empurrariam os campos de cima pra fora da dobra).
  // Header mostra a contagem; expandir é explícito.
  const evs = Array.isArray(s.events) ? [...s.events].reverse() : [];
  if (!evs.length) {
    body.append(dtSec(T('dt_timeline')));
    const e = document.createElement('div');
    e.className = 'dt-v';
    e.textContent = T('dt_no_events');
    body.append(e);
  } else {
    const head = document.createElement('div');
    head.className = 'dt-sec dt-toggle';
    const lbl = document.createElement('span');
    lbl.textContent = `${T('dt_timeline')} (${evs.length})`;
    const caret = document.createElement('span');
    caret.className = 'dt-caret';
    caret.textContent = '▸';
    head.append(lbl, caret);
    body.append(head);
    const evsBox = document.createElement('div');
    evsBox.className = 'dt-evs';
    evsBox.hidden = true;
    for (const ev of evs) {
      const row = document.createElement('div');
      row.className = 'dt-ev';
      const t = document.createElement('time');
      t.textContent = ev.ts ? new Date(ev.ts * 1000).toLocaleTimeString() : '—';
      const x = document.createElement('span');
      x.textContent = ev.event + (ev.tool ? ' · ' + ev.tool : '');
      row.append(t, x);
      evsBox.append(row);
    }
    body.append(evsBox);
    head.addEventListener('click', () => {
      evsBox.hidden = !evsBox.hidden;
      caret.textContent = evsBox.hidden ? '▸' : '▾';
    });
  }
}

// Sessão sumiu do refresh (morreu enquanto a janela estava aberta): mantém o
// card com um aviso — a janela não pode ficar mostrando o último snapshot
// como se ainda fosse verdade.
function mountDetailsGone(root, T) {
  root.querySelector('.dt-title').textContent = T('dt_title');
  const body = root.querySelector('.dt-body');
  body.replaceChildren();
  const e = document.createElement('div');
  e.className = 'dt-v';
  e.textContent = T('dt_gone');
  body.append(e);
}

// Bootstrap da JANELA (details.html). api = window.trafficLight do preload:
// onDetailsData(cb), closeDetails(), copyText(t), getLang(), getAliases().
// O main empurra { s, readAt } a cada refresh de sessões — s === null quando a
// sessão encerrou. Esc e × fecham (destrói a janela no main).
function initDetailsWindow(api) {
  const card = document.querySelector('.dt-card');
  let T = makeT('en');
  let aliases = {};
  Promise.all([api.getLang(), api.getAliases()])
    .then(([lang, a]) => {
      T = makeT(lang || 'en');
      aliases = a || {};
      mountDetailsGone(card, T);   // estado inicial até o 1º push chegar
    })
    .catch(() => { mountDetailsGone(card, T); });
  api.onDetailsData(({ s, readAt }) => {
    if (!s) { mountDetailsGone(card, T); return; }
    mountDetails(card, s, {
      T,
      copy: (t) => api.copyText(t),
      aliases,
      readAt: readAt || 0,
      agentLabel: (sess) => {
        const ag = AGENTS[agentOf(sess)];
        return ag ? ag.label : agentOf(sess);
      },
    });
  });
  document.querySelector('.ts-close').addEventListener('click', () => api.closeDetails());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.closeDetails(); }, true);
}

// Auto-init no browser. A CSP da página (script-src 'self') BLOQUEIA <script>
// inline — a chamada não pode viver no details.html; o módulo se inicializa
// sozinho quando a bridge do preload existe (padrão dos scripts clássicos).
// No vm dos testes window.trafficLight não existe: o init fica a cargo do
// próprio teste (initDetailsWindow(api) explícito).
if (typeof window !== 'undefined' && window.trafficLight) initDetailsWindow(window.trafficLight);

// Export Node (testes) — no browser vira global via <script>.
if (typeof module !== 'undefined') module.exports = {
  basename, labelFor, dtSec, dtRow, mountDetails, mountDetailsGone, initDetailsWindow,
};
