// renderer.js — monta a lista suspensa a partir das sessões observadas.
// Estado (cor) via computeState() (state-machine.js, escopo global — não redeclarar).

let sessions = [];
let expanded = true;
let renaming = false;                      // input de rename aberto → suspende render()
let aliases = {};                          // sessionKey (session_id|pid) -> apelido
let settingsCfg = null;                    // {idleThresholdSec, escalateIdle} do settings.json
let lastLangPref = null;                    // pref de idioma aplicada ('auto'|'en'|'pt') — evita re-resolver o idioma a cada settings-changed (live-apply)
let T = makeT('en');                       // i18n — troca pro idioma do sistema via get-lang
let firstRender = true;                    // hidrata prevLevels sem alertar no boot
const seenOrigins = new Set();             // origins já vistas (peer novo = hidrata sem apitar)
const prevLevels = new Map();              // pid -> level (detecção de transição p/ vermelho)
const lastAlert = new Map();               // pid -> ms (rate-limit do alerta)
const snoozed = new Map();                 // key -> ms (silencia o ALERTA até então; a cor fica)
const readMarks = new Map();               // key -> ts (epoch s): sessão marcada LIDA até esse evento; > → cinza
let everHadSessions = false;               // onboarding: mostra "instalar hooks" só enquanto nunca teve sessão
let launchers = [];                        // Quick Launcher: [{id,label}] dos CLIs detectados
let usageEntries = [];                     // consumo/reset: [{agent,title,usedPct,resetAt,resetInMin,extra,source,error}]
let appVersion = '';                       // versão do app (rodapé direito)
let updateInfo = null;                     // {current,method,latest,hasUpdate,url,error} do GitHub
const SNOOZE_MS = 60 * 60 * 1000;          // 1h
function snoozeKey(s) { return sessionKey(s); }
// Identidade da LINHA p/ o apelido persistido — nunca o cwd. Dois terminais no
// mesmo diretório são linhas distintas (session_id/pid diferentes) e devem
// poder ter nomes distintos; indexar por cwd fazia renomear um renomear todos.
// session_id primeiro: é o que Claude/Codex reusam no --resume e persistem em
// disco, então o apelido sobrevive a restart do app/sessão; pid é o fallback
// (procs headless, cujo session_id já é `proc-<pid>`). String() p/ o guard do IPC.
function aliasKey(s) { return String(s.session_id || s.pid || ''); }
function isSnoozed(key) {
  const until = snoozed.get(key);
  if (!until) return false;
  if (Date.now() > until) { snoozed.delete(key); return false; } // expirou — limpa
  return true;
}

const HEADER_H = 58; // tem que casar com --header-h do CSS

const $list = document.getElementById('list');
const $empty = document.getElementById('empty');
const $counts = document.getElementById('counts');
const $usage = document.getElementById('usage');
const $ver = document.getElementById('verBtn');
const $toggleList = document.getElementById('toggleListBtn');
const $toggleFooter = document.getElementById('toggleFooterBtn');
const $forceUsage = document.getElementById('forceUsageBtn');
const $summaryLed = document.getElementById('summaryLed');
const $expand = document.getElementById('expandBtn');
const $quit = document.getElementById('quitBtn');

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}
function ageText(nowSec, ts) {
  if (!ts) return '';
  const s = Math.max(0, nowSec - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}`;
}
function labelFor(s) {
  const alias = aliases[aliasKey(s)];
  if (alias) return alias;
  if (s.cwd) return basename(s.cwd);
  return AGENTS[agentOf(s)].label.toLowerCase() + ' · ' + s.pid;
}

function setExpanded(v) {
  expanded = v;
  // Lista some quando recolhido (vira só header + rodapé). Também some com 0
  // sessões: visível com 0 linhas ela flex-grow e empurra o .empty pra baixo —
  // offsetTop deixaria de ser natural e o autosize entraria em loop de feedback.
  $list.hidden = !v || sessions.length === 0;
  $empty.hidden = !v || sessions.length > 0;
  $expand.classList.toggle('is-expanded', v);
  // Recolhido: a janela encolhe pra cabeçalho + rodapé (a lista some). O
  // rodapé (usage + launcher) só não conta se estiver vazio — aí fica só o header.
  if (!v) {
    window.trafficLight.setExpanded(false, collapsedHeight());
  } else {
    window.trafficLight.setExpanded(true);
    autosize();
  }
}

// Altura do estado RECOLHIDO = header + rodapé visível (usage OU launcher). Só
// um dos dois aparece por vez (footerShowsUsage), então some a altura de quem
// está visível. Usado ao recolher E ao alternar o rodapé enquanto recolhido —
// senão a janela mantinha o espaço do rodapé anterior (bug: vazio embaixo).
function collapsedHeight() {
  const $bar = document.getElementById('launcher');
  const $u = document.getElementById('usage');
  const launcherH = ($bar && !$bar.hidden) ? $bar.offsetHeight : 0;
  const usageH = ($u && !$u.hidden) ? $u.offsetHeight : 0;
  return HEADER_H + launcherH + usageH;
}

// ---- alerta no vermelho: som (Web Audio) + notificação nativa ----
// O som segue as Preferências (settings.soundEnabled/soundVolume/soundType/
// soundFile): um preset sintético (sound.js) ou um arquivo do usuário decodificado
// via Web Audio. O arquivo é carregado sob demanda quando a config muda.
let audioCtx = null;
let customBuffer = null;      // AudioBuffer do arquivo custom decodificado
let customBufferFor = null;   // soundFile que o buffer representa (evita redecodificar)
function ensureAudioCtx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// Busca os bytes do arquivo custom (via IPC) e decodifica num AudioBuffer.
// Idempotente: só redecodifica se o caminho mudou. Falha → sem buffer (o beep cai
// no preset). Chamado quando settingsCfg é aplicado/muda.
async function loadCustomSound(file) {
  if (!file) { customBuffer = null; customBufferFor = null; return; }
  if (file === customBufferFor && customBuffer) return;
  try {
    const bytes = await window.trafficLight.getSoundBytes(file);   // Uint8Array | null
    if (!bytes || !bytes.byteLength) throw new Error('sem bytes');
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    customBuffer = await ensureAudioCtx().decodeAudioData(ab);
    customBufferFor = file;
  } catch { customBuffer = null; customBufferFor = null; }
}
function beep() {
  try {
    const cfg = settingsCfg || {};
    if (cfg.soundEnabled === false) return;                        // som desligado
    const ctx = ensureAudioCtx();
    const vol = typeof cfg.soundVolume === 'number' ? cfg.soundVolume : 0.18;
    if (cfg.soundType === 'custom' && customBuffer) { playBuffer(ctx, customBuffer, vol); return; }
    playPreset(ctx, cfg.soundType || 'beep', vol);                 // custom sem buffer pronto → preset
  } catch {}
}
function alertAwaiting(s) {
  beep();
  window.trafficLight.notify('⚠ ' + T('needs_you', { agent: AGENTS[agentOf(s)].label }), labelFor(s));
}

// Textos estáticos do HTML (empty state, tooltips) no idioma do sistema.
// Tooltips agora são customizados (data-tip); i18n preenche data-tip a partir
// de data-i18n-tip (o setupTooltips lê data-tip no hover).
function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-tip]')) el.setAttribute('data-tip', T(el.dataset.i18nTip));
}

// ---- rename in-place ----
// Enquanto o input está aberto, `renaming` suspende render() — senão o
// replaceChildren() de um tick de idle (2s) ou de um evento de sessão
// arrancaria o input do DOM no meio da digitação (issue #2).
function startRename(s, labelEl) {
  const key = aliasKey(s);
  if (!key || renaming) return;
  if (s.origin && s.origin !== 'local') return;   // linha remota: rename é local-only (não sincroniza)
  renaming = true;
  const input = document.createElement('input');
  input.className = 'row-input';
  input.value = aliases[key] || (s.cwd ? basename(s.cwd) : '');
  labelEl.replaceChildren(input);
  input.focus(); input.select();

  // finish() é idempotente (`done`): ao commitar via Enter, o render()
  // seguinte remove o input e dispara um blur — que NÃO deve re-salvar
  // (e no Escape, jamais salvar o texto digitado).
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = false;
    if (save) {
      window.trafficLight.setAlias(key, input.value);
      aliases[key] = input.value.trim();
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));   // clicar fora = commit
  input.addEventListener('click', (e) => e.stopPropagation());
}

function render() {
  if (renaming) return;                    // não destrói o input aberto (issue #2)
  const nowSec = Math.floor(Date.now() / 1000);
  let worst = 'done';
  const tally = { processing: 0, done: 0, awaiting: 0, read: 0 };
  const markRead = !settingsCfg || settingsCfg.markReadOnClick !== false;

  // Origins que aparecem pela 1ª vez neste render (origens novas = peer acabou
  // de conectar). Suas sessões são HIDRATADAS (prevLevels semeado) — não apita
  // tudo de uma vez quando um peer entra; só transições futuras disparam alerta.
  const newOrigins = new Set();
  for (const s of sessions) { const o = s.origin || 'local'; if (!seenOrigins.has(o)) newOrigins.add(o); }

  // 1. computa estado de cada sessão (+ tally/worst no mesmo passo).
  const ranked = sessions.map((s) => {
    const key = sessionKey(s);
    // readAt só conta se a feature está ligada; senão computeState ignora.
    const readAt = markRead ? readMarks.get(key) : undefined;
    const st = computeState(s, nowSec, settingsCfg, readAt);
    tally[st.level]++;
    if (st.level === 'awaiting') worst = 'awaiting';
    else if (st.level === 'processing' && worst !== 'awaiting') worst = 'processing';

    // Alerta ao TRANSITAR pra vermelho (rate-limit 30s/sessão). Na 1ª render
    // só hidrata prevLevels — uma sessão que JÁ estava vermelha ao abrir o app
    // não deve apitar (só transições reais disparam alerta). Sessão marcada
    // lida está em 'read' (não 'awaiting'), então não apita — reacende só com
    // evento vermelho novo (que volta pra 'awaiting' e passa por aqui).
    // 1ª aparição da ORIGEM (peer novo, ou o boot): semeia prevLevels p/ não
    // estourar alerta em sessões que JÁ estavam vermelhas quando chegaram.
    if (newOrigins.has(s.origin || 'local')) prevLevels.set(key, st.level);
    const was = prevLevels.get(key);
    if (!firstRender && st.level === 'awaiting' && was !== 'awaiting' && !isSnoozed(key)) {
      const nowMs = Date.now();
      if (!lastAlert.has(key) || nowMs - lastAlert.get(key) > 30000) {
        lastAlert.set(key, nowMs);
        alertAwaiting(s);
        if (settingsCfg.revealOnRed) window.trafficLight.revealOverlay(); // traz à frente se oculto
      }
    }
    prevLevels.set(key, st.level);
    return { s, st };
  });
  for (const s of sessions) seenOrigins.add(s.origin || 'local'); // registra as origins vistas

  // Limpa estado por-sessão de sessões que morreram (evita crescer sem limite
  // em uso longo). readMarks/prevLevels/lastAlert/snoozed são chaveados por
  // pid||session_id; qualquer chave fora do conjunto vivo é lixo.
  const liveKeys = new Set(sessions.map((s) => sessionKey(s)));
  for (const m of [readMarks, prevLevels, lastAlert, snoozed]) {
    for (const k of m.keys()) if (!liveKeys.has(k)) m.delete(k);
  }

  // 2. ordena por urgência: 🔴 no topo, depois 🟡, depois 🟢 (state-machine.js).
  const ordered = sortByUrgency(ranked);

  // 3. monta as linhas na ordem ordenada.
  const rows = ordered.map(({ s, st }) => {
    const label = labelFor(s);
    const key = sessionKey(s);     // p/ marcar como lido no clique
    const agent = AGENTS[agentOf(s)];
    // O ícone da LLM (à esquerda) já mostra QUAL agente — então o texto não
    // repete o nome do agente. Normal: modelo · ferramenta · tempo.
    const sub = [
      s.model,
      s.last_tool ? s.last_tool : (s.last_event || ''),
      ageText(nowSec, s.last_event_ts),
    ].filter(Boolean).join(' · ');
    // Compacto: modelo · ferramenta · tempo (o ícone da LLM à esquerda já diz o
    // agente; o modelo distingue qual variante — glm-5.2, gpt-5, etc.).
    const subCompact = [
      s.model,
      s.last_tool ? s.last_tool : (s.last_event || ''),
      ageText(nowSec, s.last_event_ts),
    ].filter(Boolean).join(' · ');

    const li = document.createElement('li');
    li.className = 'row';
    li.setAttribute('data-tip', T('row_tooltip'));
    // Clique simples = focar terminal; mas o dblclick (rename) dispara 2 cliques
    // antes — sem debounce, cada clique levanta o terminal e rouba o foco do
    // teclado do input de rename, que abre vazio/fecha na hora. Solução: espera
    // 220ms; se vier um 2º clique (dblclick), cancela o foco e deixa o rename.
    let clickTimer = null;
    li.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // 2º click do dblclick
      // Marcar como lido: o MESMO clique foca E silencia o vermelho (vira cinza)
      // — carimba até o evento atual; uma notificação nova (ts maior) reacende.
      if (markRead && st.level === 'awaiting') {
        readMarks.set(key, s.last_event_ts || nowSec);
        render();                            // reflete o cinza na hora
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        // Remoto: windowid/focus_url são machine-local (não há o que focar) →
        // abre o painel de prompts no lugar. Local: foca o terminal como antes.
        if (s.origin && s.origin !== 'local') openTranscriptPanel(s);
        else window.trafficLight.focus({ pid: s.pid, windowid: s.windowid, focus_url: s.focus_url, tilix_id: s.tilix_id });
      }, 220);
    });

    // Colunas fixas (alinham entre linhas): [led] [motivo] [LLM] [nome…] [texto] [sino]
    const led = document.createElement('span');
    led.className = `led led--${st.level}`;

    // ícone do motivo (🔑 permissão, 🛠 tool, ✓ ok, ⚠ erro, ⏰ idle…)
    const reason = document.createElement('span');
    reason.className = 'row__reason';
    reason.textContent = iconFor(st);

    // ícone da LLM/CLI (SVG da marca, cor do agente) — mostra QUAL agente
    const llm = document.createElement('span');
    llm.className = 'row__llm';
    if (agent && agent.mark) {
      llm.style.setProperty('--agent-color', agent.color || 'var(--ink-dim)');
      llm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + agent.mark + '</svg>';
    }

    const main = document.createElement('span');
    main.className = 'row__main';

    const labelEl = document.createElement('span');
    labelEl.className = 'row__label';
    labelEl.textContent = label;
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // era clique simples pendente → cancela o foco
      startRename(s, labelEl);
    });

    const subEl = document.createElement('span');
    subEl.className = 'row__sub';
    subEl.textContent = sub;                 // normal
    const subInline = document.createElement('span');
    subInline.className = 'row__sub-inline'; // compacto: na mesma linha do nome
    subInline.textContent = subCompact;
    // Clique no sub-texto (modelo · ferramenta · tempo) abre o painel "ver prompt"
    // SÓ pra remota (local: deixa o clique subir e foca o terminal de verdade —
    // painel só faz sentido onde não dá pra focar).
    const openTs = (e) => {
      if (!(s.origin && s.origin !== 'local')) return;   // local: clique sobe → focus
      e.stopPropagation();
      openTranscriptPanel(s);
    };
    subEl.addEventListener('click', openTs);
    subInline.addEventListener('click', openTs);
    subEl.title = subInline.title = T('ts_see_prompt');

    // Badge de origem em sessão REMOTA (de qual máquina/peer veio).
    if (s.origin && s.origin !== 'local') {
      const badge = document.createElement('span');
      badge.className = 'row__origin';
      badge.textContent = s.origin;
      main.append(badge);
    }
    main.append(labelEl, subEl, subInline);
    li.append(led, reason, llm, main);

    // Snooze do alerta (só em vermelho): não apaga a cor, só cala o beep/notif.
    // A coluna do sino é SEMPRE reservada (placeholder invisível quando não-red)
    // para não empurrar a altura/largura da linha ao aparecer/sumir.
    const snoozeWrap = document.createElement('span');
    snoozeWrap.className = 'row__snooze-col';
    if (st.level === 'awaiting') {
      const sk = snoozeKey(s);
      const muted = isSnoozed(sk);
      const btn = document.createElement('button');
      btn.className = 'row__snooze' + (muted ? ' is-on' : '');
      btn.textContent = muted ? '🔕' : '🔔';
      btn.setAttribute('data-tip', T(muted ? 'snooze_off' : 'snooze_on'));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isSnoozed(sk)) snoozed.delete(sk);
        else snoozed.set(sk, Date.now() + SNOOZE_MS);
        render();
      });
      snoozeWrap.append(btn);
    }
    li.append(snoozeWrap);

    return li;
  });

  $list.replaceChildren(...rows);
  $summaryLed.className = `led led-summary led--${worst}`;

  const parts = [];
  if (tally.processing) parts.push(`🟡${tally.processing}`);
  if (tally.done) parts.push(`🟢${tally.done}`);
  if (tally.awaiting) parts.push(`🔴${tally.awaiting}`);
  $counts.textContent = sessions.length === 0 ? '—' : parts.join(' ');

  // Tray dinâmico: o ícone pinta com a pior cor e o tooltip leva a contagem.
  window.trafficLight.setTrayLevel({ level: worst, awaiting: tally.awaiting, processing: tally.processing, done: tally.done });

  // Onboarding: só enquanto NUNCA apareceu uma sessão (sinal de hooks não instalados).
  // Assim que a 1ª sessão surge, o banner some pra sempre nesta execução.
  everHadSessions = everHadSessions || sessions.length > 0;
  $empty.hidden = sessions.length > 0;
  if (!everHadSessions) {
    const kids = [
      Object.assign(document.createElement('strong'), { textContent: T('onboard_title') }),
      Object.assign(document.createElement('div'), { textContent: T('onboard_body'), className: 'onboard__body' }),
      Object.assign(document.createElement('button'), {
        textContent: T('onboard_btn'),
        className: 'onboard__btn',
        onclick: () => window.trafficLight.installHooks(),
      }),
    ];
    $empty.replaceChildren(...kids);
  }
  // Rodapé: uso OU launcher (nunca os dois) conforme settings.showUsage.
  renderUsage();
  renderLauncher();
  $list.hidden = !expanded || sessions.length === 0;
  document.title = `ATL · ${sessions.length} ${T('doc_sessions')} · ${parts.join(' ')}`;
  autosize();
  firstRender = false;
}

// Barra persistente de Quick Launcher (rodapé do overlay): um botão-ícone por
// CLI detectado, com a marca/cor de cada agente. Visível sempre que houver
// launchers — não só no empty state.
// ---- consumo/reset dos agentes (faixa no rodapé, uma linha por limite) ----
// Cada linha: [ícone do agente clicável] [nome/plano] .... [%] [barra fixa] [reset].
// Ícone clicável só se o agente for um launcher detectado (Claude/Gemini/...);
// GLM é backend, não se lança → ícone decorativo. Barra sempre presente
// (tamanho padronizado); % vazio mostra "—". Reset em hora local (HH:MM),
// "+Nd HH:MM" se for além de hoje, "Xmin" se <1h. Re-render a cada 2s.
// ---- label de uma linha de uso: sempre "Provider(Plano) janela" ----
// Cada linha é autônoma (repete o provedor); antes a 2ª linha de um mesmo
// plano ficava sem provedor, parecendo outro agente (bug do "2 GLM sem z.ai").
const USAGE_PROVIDER = { claude: 'Claude', glm: 'z.ai', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' };
function usagePlanName(u) {
  const plan = u.plan || '';
  if (!plan) return '';
  if (u.agent === 'claude') return plan.replace(/^Claude\s+/, '');
  if (u.agent === 'codex') return plan.replace(/^Codex\s+/, '');
  if (u.agent === 'glm') return plan.replace(/^GLM\s+/, '').replace(/\s*\(z\.ai\)\s*$/, '');
  if (u.agent === 'antigravity') return plan.replace(/^Antigravity\s*\(/, '').replace(/\)\s*$/, '');
  return plan;
}
function usageWindow(u) {
  if (u.agent === 'antigravity') return '';                  // rótulo só, sem janela
  const t = u.title || '';
  if (!t) return '';
  if (/5\s*h/i.test(t)) return '5h';
  if (/7\s*d/i.test(t)) return '7d';
  if (/mês|mes|mcp/i.test(t)) return 'Mês';
  return t;
}
function usageLabel(u) {
  const provider = USAGE_PROVIDER[u.agent] || (u.plan ? u.plan.split(/[\s(]/)[0] : (u.agent || '?'));
  const plan = usagePlanName(u);
  const win = usageWindow(u);
  const head = plan ? `${provider}(${plan})` : provider;
  return win ? `${head} ${win}` : head;
}

function pctLevel(pct) {
  if (pct == null) return 'none';
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'amber';
  return 'green';
}
function resetClock(resetAt, resetInMin) {
  if (typeof resetInMin === 'number' && resetInMin > 0 && resetInMin < 60) return `${resetInMin}min`;
  if (!resetAt) return '';
  const d = new Date(resetAt);
  if (isNaN(d.getTime())) return '';

  const now = Date.now();
  const diffMs = d.getTime() - now;
  if (diffMs <= 0) return '';

  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}min`;

  const diffHours = Math.round(diffMs / 3600000);
  if (diffHours < 24) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`; // Mostra a hora do reset se for nas próximas 24h
  }

  const diffDays = Math.round(diffMs / 86400000);
  return `${diffDays}d`;
}
// Aparência (Preferências): transparência do painel via --bg-alpha e modo
// compacto via classe no .overlay. Aplicado ao vivo (boot + settings-changed),
// sem reiniciar — o CSS já deriva --bg de --bg-alpha. autosize recalcula a
// altura (compact muda a altura das linhas).
function applyAppearance() {
  const op = settingsCfg && typeof settingsCfg.opacity === 'number' ? settingsCfg.opacity : 0.97;
  document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0.6, Math.min(1, op))));
  const compact = !!(settingsCfg && settingsCfg.compact);
  const $ov = document.getElementById('overlay');
  if ($ov) $ov.classList.toggle('compact', compact);
  if ($toggleList) $toggleList.classList.toggle('is-on', compact); // header: destaca quando compacto
  autosize();
}

// Modo do rodapé: showUsage (settings) decide se aparece a barra de USO ou a
// barra de LAUNCHER — só uma por vez. Default true (uso). O toggle no header
// alterna e persiste via save-settings.
function footerShowsUsage() {
  return !settingsCfg || settingsCfg.showUsage !== false;
}
function applyFooterMode() {
  const showUsage = footerShowsUsage();
  renderUsage();
  renderLauncher();
  // A visibilidade real é decidida dentro de cada render (podem estar vazios),
  // mas o modo esconde o outro de vez.
  const $l = document.getElementById('launcher');
  if (showUsage) { if ($l) $l.hidden = true; }
  else { if ($usage) $usage.hidden = true; }
  if ($toggleFooter) $toggleFooter.classList.toggle('is-on', !showUsage); // destaca no modo launcher
  // Re-mede a altura: expandido → autosize; recolhido → altura do rodapé novo
  // (autosize é no-op quando recolhido, então a janela mantinha o espaço do
  // rodapé anterior — sobrava vazio ao trocar usage↔launcher recolhido).
  if (expanded) autosize();
  else window.trafficLight.setExpanded(false, collapsedHeight());
}

// Faixa de uso = painel de medidores. Cada limite é um "canal": ícone · nome ·
// medidor (trilho + preenchimento que acende) · leitura (% grande) · reset. O
// CSS Grid vive no CONTÊINER (.usage-bar) com colunas compartilhadas, então
// TODAS as linhas alinham nas mesmas colunas — trilhos idênticos, reset com
// espaço igual — independentemente do texto. Cada .urow é display:contents pra
// seus filhos caírem direto no grid do pai.
function renderUsage() {
  if (!$usage) return;
  if (!footerShowsUsage() || !usageEntries.length) { $usage.hidden = true; $usage.replaceChildren(); return; }
  const launchable = new Set(launchers.map((l) => l.id));
  // Cada linha é autônoma: "Provider(Plano) janela" — sempre mostra o provedor
  // (antes a 2ª linha de um mesmo plano ficava sem provedor, parecendo outro
  // agente). Provider/Plano/Janela derivados dos campos do coletor (usageLabel).
  const rows = usageEntries.map((u) => {
    const a = AGENTS[u.agent] || { label: u.title || u.agent, color: 'rgba(255,255,255,0.3)' };
    // stale (valor antigo, coletor sem atualizar há alguns min) → cinza, sem
    // apagar o número; o valor continua visível, só sinaliza que está velho.
    const lvl = u.stale ? 'none' : pctLevel(u.usedPct);
    const reset = resetClock(u.resetAt, u.resetInMin);
    const nameTxt = usageLabel(u);
    const hasPct = u.usedPct != null;

    const row = document.createElement('div');
    row.className = `urow urow--${lvl}` + (u.stale ? ' urow--stale' : '');
    row.style.setProperty('--agent-color', a.color || 'rgba(255,255,255,0.3)');
    row.style.setProperty('--pct', (hasPct ? u.usedPct : 0));
    // tooltip completo (o .urow é display:contents/sem caixa → vai no .name).
    const tipTxt = [nameTxt, hasPct ? u.usedPct + '%' : null,
      reset ? 'reset ' + reset : null, u.stale ? 'sem atualizar' : null, u.extra, u.error].filter(Boolean).join(' · ');

    // ícone: botão clicável (lança o agente) se for um launcher; span decorativo senão.
    let icon;
    if (a.mark && launchable.has(u.agent)) {
      icon = document.createElement('button');
      icon.className = 'urow__icon';
      icon.setAttribute('data-tip', '+ ' + a.label);
      icon.addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.launchAgent({ agent: u.agent }); });
    } else {
      icon = document.createElement('span');
      icon.className = 'urow__icon urow__icon--static';
    }
    if (a.mark) icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + a.mark + '</svg>';

    const name = document.createElement('span'); name.className = 'urow__name'; name.textContent = nameTxt;
    name.setAttribute('data-tip', tipTxt);

    // leitura: número grande (cor da faixa) + sinal % pequeno; "—" quando sem dado.
    const read = document.createElement('span'); read.className = 'urow__read';
    if (hasPct) {
      const num = document.createElement('b'); num.className = 'urow__num'; num.textContent = u.usedPct;
      const sign = document.createElement('span'); sign.className = 'urow__sign'; sign.textContent = '%';
      read.append(num, sign);
    } else {
      const dash = document.createElement('b'); dash.className = 'urow__num urow__num--empty'; dash.textContent = u.error ? '⚠' : '—';
      read.append(dash);
    }

    // medidor: trilho (canaleta) + preenchimento (largura via --pct) com cap de brilho.
    const meter = document.createElement('span'); meter.className = 'urow__meter';
    const fill = document.createElement('i'); fill.className = 'urow__fill'; meter.append(fill);

    // reset: coluna SEMPRE presente (mantém o espaço igual mesmo vazia).
    const rst = document.createElement('span'); rst.className = 'urow__reset';
    rst.textContent = reset ? reset : '';

    row.append(icon, name, read, meter, rst);
    return row;
  });
  $usage.replaceChildren(...rows);
  $usage.hidden = false;
}

function renderLauncher() {
  const $bar = document.getElementById('launcher');
  if (!$bar) return;
  $bar.replaceChildren();
  for (const l of launchers) {
    const a = AGENTS[l.id];
    if (!a || !a.mark) continue;
    const btn = document.createElement('button');
    btn.className = 'launcher-btn';
    btn.style.setProperty('--agent-color', a.color || 'rgba(255,255,255,0.10)');
    btn.setAttribute('data-tip', '+ ' + a.label);
    // Ícone + label: o label desliza (max-width) no hover, formando uma pílula
    // "✦ Claude" animada. Sem hover, só o ícone (compacto, 26px).
    btn.innerHTML = '<span class="launcher-btn__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + a.mark + '</svg></span><span class="launcher-btn__label">' + a.label + '</span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.launchAgent({ agent: l.id }); });
    $bar.append(btn);
  }
  // Launcher só aparece quando o modo do rodapé NÃO é uso e há launchers.
  $bar.hidden = footerShowsUsage() || launchers.length === 0;
}

// Versão + update no HEADER (à esquerda da engrenagem). Sem update: texto
// discreto "vX.Y.Z". Com update: vira botão verde "↑ vNOVA" que abre a release.
function renderVersion() {
  if (!$ver) return;
  if (!appVersion && !updateInfo) { $ver.hidden = true; return; }
  const u = updateInfo || {};
  // status: idle | available | downloading | ready | error  (fail-soft cai em available/idle)
  const status = u.status || (u.hasUpdate ? 'available' : 'idle');
  const method = u.method || '';
  const arrowSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  $ver.hidden = false;
  $ver.classList.toggle('has-update', status === 'available' || status === 'ready');
  if (status === 'available') {
    if (u.canAutoInstall) {                                  // AppImage: baixa + instala
      $ver.innerHTML = '↓ v' + u.latest;
      $ver.setAttribute('data-tip', T('update_download', { v: u.latest, method }));
    } else {                                                 // demais métodos: abre a release
      $ver.innerHTML = arrowSvg + 'v' + u.latest;
      $ver.setAttribute('data-tip', T('update_available', { v: u.latest, method }));
    }
  } else if (status === 'downloading') {
    $ver.innerHTML = '↓ ' + (u.progress || 0) + '%';
    $ver.setAttribute('data-tip', T('update_downloading', { p: (u.progress || 0) }));
  } else if (status === 'ready') {
    $ver.innerHTML = '↻ v' + u.latest;                       // reiniciar pra instalar
    $ver.setAttribute('data-tip', T('update_ready', { v: u.latest }));
  } else {
    $ver.textContent = 'v' + (appVersion || '?');            // idle / error → discreto
    if (method) $ver.setAttribute('data-tip', T('installed_via', { method })); else $ver.removeAttribute('data-tip');
  }
}

function autosize() {
  if (!expanded) return;
  // Mede a posição NATURAL da última linha (ou do empty). offsetTop é relativo
  // ao .overlay (position:relative), já inclui o header. As linhas ficam no
  // topo do list, então essa posição é a natural — independe da altura flex
  // da janela (o que evita o loop de feedback que a fazia crescer sozinha).
  const $bar = document.getElementById('launcher');
  const $u = document.getElementById('usage');
  const launcherH = ($bar && !$bar.hidden) ? $bar.offsetHeight : 0;
  const usageH = ($u && !$u.hidden) ? $u.offsetHeight : 0;
  let bottom;
  if (sessions.length) {
    const last = $list.lastElementChild;
    bottom = last ? (last.offsetTop + last.offsetHeight + 10) : (HEADER_H + 40);
  } else {
    bottom = $empty.offsetTop + $empty.offsetHeight + 8;
  }
  window.trafficLight.autoHeight(bottom + launcherH + usageH + 4);
}

// Persiste o estado de UI (footer + recolhido) sem exibir em Preferências —
// grava as chaves atuais no settings.json via save-settings. Chamado quando o
// usuário alterna o footer ou recolhe/expande a janela.
function persistUI(patch) {
  settingsCfg = { ...(settingsCfg || {}), ...patch };
  window.trafficLight.saveSettings(settingsCfg); // main reemite settings-changed
}

// Eventos de UI
$expand.addEventListener('click', () => {
  setExpanded(!expanded);
  persistUI({ collapsed: !expanded });           // lembra recolhido/expandido
});
$quit.addEventListener('click', () => window.trafficLight.toggleVisibility()); // × esconde (tray)
document.getElementById('settingsBtn').addEventListener('click', () => window.trafficLight.openSettings());

// Toggle da LISTA (header): alterna normal/compacto e persiste em settings.compact.
if ($toggleList) $toggleList.addEventListener('click', () => {
  const next = !(settingsCfg && settingsCfg.compact);
  persistUI({ compact: next });
  applyAppearance();                        // aplica a classe .compact + reajusta altura
});
// Toggle do RODAPÉ (header): alterna uso ⇄ launcher e persiste em settings.showUsage.
if ($toggleFooter) $toggleFooter.addEventListener('click', () => {
  persistUI({ showUsage: !footerShowsUsage() });
  applyFooterMode();
});
// Force (⟳): recoleta o uso na hora (fura o cache de conveniência; o cooldown do
// 429 continua respeitado no main). Gira o ícone ~600ms como feedback — o push
// de 'usage' chega logo depois e re-renderiza os tiles.
let claudeCooldownUntil = 0;
function applyUsageMeta(meta) {
  claudeCooldownUntil = (meta && typeof meta.claudeCooldownUntil === 'number') ? meta.claudeCooldownUntil : 0;
  if (!$forceUsage) return;
  if (claudeCooldownUntil > Date.now()) {
    const min = Math.ceil((claudeCooldownUntil - Date.now()) / 60000);
    $forceUsage.setAttribute('data-tip', T('tooltip_force_cooldown', { min }));
    $forceUsage.classList.add('is-cooldown');
  } else {
    $forceUsage.setAttribute('data-tip', T('tooltip_force_usage'));
    $forceUsage.classList.remove('is-cooldown');
  }
}
if ($forceUsage) $forceUsage.addEventListener('click', () => {
  // Bloqueado durante o cooldown do 429: recoletar não traria % novo (o coletor
  // respeita o cooldown) e o spinner daria falsa impressão de atualização. O
  // tooltip já explica "aguarde Xmin"; aqui só não dispara nada.
  if (claudeCooldownUntil > Date.now()) return;
  window.trafficLight.forceUsage();
  $forceUsage.classList.add('is-spinning');
  setTimeout(() => $forceUsage.classList.remove('is-spinning'), 600);
});

// Botão de versão: ramifica por estado. available → baixar (AppImage) ou abrir
// release (demais); ready → reiniciar e instalar; idle/error → "verificar agora".
if ($ver) $ver.addEventListener('click', () => {
  const u = updateInfo || {};
  if (u.status === 'available') {
    if (u.canAutoInstall) window.trafficLight.downloadUpdate();
    else if (u.url) window.trafficLight.openExternal(u.url);
  } else if (u.status === 'ready') {
    window.trafficLight.installUpdate();
  } else if (!u.status || u.status === 'idle' || u.status === 'error') {
    window.trafficLight.checkUpdate();
  }
});

// Gripper de resize (largura).
const $grip = document.getElementById('grip');
let resizing = null;
$grip.addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizing = { sx: e.screenX, sy: e.screenY };
  window.trafficLight.resizeStart();
});
window.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  window.trafficLight.resizeMove(e.screenX - resizing.sx, e.screenY - resizing.sy);
});
window.addEventListener('mouseup', () => { resizing = null; });

// Recebe sessões; pede carga inicial; carrega idioma, apelidos e settings.
window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyStaticI18n(); render(); });
window.trafficLight.onSessions((s) => { sessions = s || []; render(); });
window.trafficLight.requestSessions();
window.trafficLight.onUsage((u) => { usageEntries = Array.isArray(u) ? u : []; applyFooterMode(); });
window.trafficLight.onUsageMeta((m) => applyUsageMeta(m));
window.trafficLight.requestUsage();
window.trafficLight.getVersion().then((v) => { appVersion = v || ''; renderVersion(); });
window.trafficLight.getUpdate().then((i) => { updateInfo = i || null; renderVersion(); });
window.trafficLight.onUpdateState((s) => { updateInfo = s || null; renderVersion(); });
window.trafficLight.getAliases().then((a) => { aliases = a || {}; render(); });
window.trafficLight.getLaunchers().then((l) => { launchers = l || []; render(); });
window.trafficLight.getSettings().then((c) => {
  settingsCfg = c;
  lastLangPref = c && c.lang;
  if (c && c.soundType === 'custom') loadCustomSound(c.soundFile);  // pré-carrega o áudio custom
  // Restaura o estado de UI salvo: recolhido/expandido (default expandido).
  setExpanded(!(c && c.collapsed));
  applyAppearance();                       // transparência + modo compacto
  applyFooterMode();
  render();
});
window.trafficLight.onSettingsChanged((c) => {
  const langChanged = !c || c.lang !== lastLangPref;  // só re-resolve idioma se a PREF mudou
  lastLangPref = c && c.lang;
  settingsCfg = c;
  loadCustomSound(c && c.soundType === 'custom' ? c.soundFile : null); // recarrega/limpa o áudio custom
  applyAppearance();                       // opacity/compact podem ter mudado
  applyFooterMode();                       // footer pode ter mudado (showUsage)
  render();
  // o idioma pode ter mudado nas Preferências — re-resolve e re-aplica estáticos.
  // Guardado: no live-apply isto dispara a cada mudança (ex.: arraste de opacity);
  // getLang()+applyStaticI18n()+render() a cada tick causaria jank e re-render duplo.
  if (langChanged) {
    window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyStaticI18n(); render(); });
  }
});

// Re-renderiza a cada 2s (escalada idle + reavaliação do alerta).
setInterval(render, 2000);

// Tooltips customizados: um só listener no overlay (delegação) cobre header,
// linhas de uso, launcher — inclusive elementos criados depois. setupTooltips
// é global (src/tooltip.js). Guardado por typeof pra não quebrar em teste.
if (typeof setupTooltips === 'function') {
  const $ov = document.getElementById('overlay');
  const $tip = document.getElementById('tooltip');
  if ($ov && $tip) setupTooltips($ov, $tip, { delay: 380 });
}

// Estado inicial antes do getSettings resolver: expandido (o settings salvo
// sobrescreve assim que chega). Sem isso o 1º paint fica sem dimensão definida.
setExpanded(true);
render();

// ---- painel "ver prompt" (transcript) — fase 3 ----
// Abre num clique no sub-texto da linha. Busca as últimas N mensagens sob
// demanda (local lê disco; remoto via /transcript no peer) — nunca no poll.
// textContent p/ o texto da mensagem (sem injeção de HTML vindo do prompt).
let $tsPanel = null;
function openTranscriptPanel(s) {
  const $ov = document.getElementById('overlay');
  if (!$ov) return;
  if (!$tsPanel) {
    $tsPanel = document.createElement('div');
    $tsPanel.className = 'ts-panel';
    $tsPanel.innerHTML = '<div class="ts-head"><span class="ts-title"></span><button class="ts-close" aria-label="fechar">×</button></div><div class="ts-body"></div>';
    $tsPanel.querySelector('.ts-close').addEventListener('click', () => $tsPanel.remove());
  }
  $ov.appendChild($tsPanel);
  $tsPanel.querySelector('.ts-title').textContent =
    labelFor(s) + (s.origin && s.origin !== 'local' ? ' · ' + s.origin : '');
  const body = $tsPanel.querySelector('.ts-body');
  body.innerHTML = '<div class="ts-loading">' + T('ts_loading') + '…</div>';
  window.trafficLight.fetchTranscript(s.origin || 'local', s.session_id, 20)
    .then((msgs) => {
      if (!Array.isArray(msgs) || !msgs.length) { body.innerHTML = '<div class="ts-empty">' + T('ts_empty') + '</div>'; return; }
      body.innerHTML = '';   // limpa o "loading"
      for (const m of msgs) {
        const row = document.createElement('div');
        row.className = 'ts-msg ts-' + m.role;
        const role = document.createElement('span'); role.className = 'ts-role'; role.textContent = m.role;
        const text = document.createElement('span'); text.className = 'ts-text'; text.textContent = m.text;
        row.append(role, text);
        body.appendChild(row);
      }
    })
    .catch(() => { body.innerHTML = '<div class="ts-empty">' + T('ts_error') + '</div>'; });
}
