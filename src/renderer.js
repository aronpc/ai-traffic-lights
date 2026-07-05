// renderer.js — monta a lista suspensa a partir das sessões observadas.
// Estado (cor) via computeState() (state-machine.js, escopo global — não redeclarar).

let sessions = [];
let expanded = true;
let renaming = false;                      // input de rename aberto → suspende render()
let aliases = {};                          // cwd -> apelido
let settingsCfg = null;                    // {idleThresholdSec, escalateIdle} do settings.json
let T = makeT('en');                       // i18n — troca pro idioma do sistema via get-lang
let firstRender = true;                    // hidrata prevLevels sem alertar no boot
const prevLevels = new Map();              // pid -> level (detecção de transição p/ vermelho)
const lastAlert = new Map();               // pid -> ms (rate-limit do alerta)
const snoozed = new Map();                 // key -> ms (silencia o ALERTA até então; a cor fica)
let everHadSessions = false;               // onboarding: mostra "instalar hooks" só enquanto nunca teve sessão
let launchers = [];                        // Quick Launcher: [{id,label}] dos CLIs detectados
const SNOOZE_MS = 60 * 60 * 1000;          // 1h
function snoozeKey(s) { return s.pid || s.session_id; }
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
  if (s.cwd && aliases[s.cwd]) return aliases[s.cwd];
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
  // rodapé só não conta se estiver vazio (sem launchers) — aí fica só o header.
  if (!v) {
    const $bar = document.getElementById('launcher');
    const launcherH = ($bar && !$bar.hidden) ? $bar.offsetHeight : 0;
    window.trafficLight.setExpanded(false, HEADER_H + launcherH);
  } else {
    window.trafficLight.setExpanded(true);
    autosize();
  }
}

// ---- alerta no vermelho: beep (Web Audio) + notificação nativa ----
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.start(t); o.stop(t + 0.35);
  } catch {}
}
function alertAwaiting(s) {
  beep();
  window.trafficLight.notify('⚠ ' + T('needs_you', { agent: AGENTS[agentOf(s)].label }), labelFor(s));
}

// Textos estáticos do HTML (empty state, tooltips) no idioma do sistema.
function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = T(el.dataset.i18nTitle);
}

// ---- rename in-place ----
// Enquanto o input está aberto, `renaming` suspende render() — senão o
// replaceChildren() de um tick de idle (2s) ou de um evento de sessão
// arrancaria o input do DOM no meio da digitação (issue #2).
function startRename(s, labelEl) {
  if (!s.cwd || renaming) return;
  renaming = true;
  const input = document.createElement('input');
  input.className = 'row-input';
  input.value = aliases[s.cwd] || basename(s.cwd);
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
      window.trafficLight.setAlias(s.cwd, input.value);
      aliases[s.cwd] = input.value.trim();
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
  const tally = { processing: 0, done: 0, awaiting: 0 };

  // 1. computa estado de cada sessão (+ tally/worst no mesmo passo).
  const ranked = sessions.map((s) => {
    const st = computeState(s, nowSec, settingsCfg);
    tally[st.level]++;
    if (st.level === 'awaiting') worst = 'awaiting';
    else if (st.level === 'processing' && worst !== 'awaiting') worst = 'processing';

    // Alerta ao TRANSITAR pra vermelho (rate-limit 30s/sessão). Na 1ª render
    // só hidrata prevLevels — uma sessão que JÁ estava vermelha ao abrir o app
    // não deve apitar (só transições reais disparam alerta).
    const key = s.pid || s.session_id;
    const was = prevLevels.get(key);
    if (!firstRender && st.level === 'awaiting' && was !== 'awaiting' && !isSnoozed(key)) {
      const nowMs = Date.now();
      if (!lastAlert.has(key) || nowMs - lastAlert.get(key) > 30000) {
        lastAlert.set(key, nowMs);
        alertAwaiting(s);
      }
    }
    prevLevels.set(key, st.level);
    return { s, st };
  });

  // 2. ordena por urgência: 🔴 no topo, depois 🟡, depois 🟢 (state-machine.js).
  const ordered = sortByUrgency(ranked);

  // 3. monta as linhas na ordem ordenada.
  const rows = ordered.map(({ s, st }) => {
    const label = labelFor(s);
    const sub = [
      AGENTS[agentOf(s)].label,               // qual agente (claude, gemini, ...)
      s.model,
      s.last_tool ? s.last_tool : (s.last_event || ''),
      ageText(nowSec, s.last_event_ts),
    ].filter(Boolean).join(' · ');

    const li = document.createElement('li');
    li.className = 'row';
    li.title = T('row_tooltip');
    // Clique simples = focar terminal; mas o dblclick (rename) dispara 2 cliques
    // antes — sem debounce, cada clique levanta o terminal e rouba o foco do
    // teclado do input de rename, que abre vazio/fecha na hora. Solução: espera
    // 220ms; se vier um 2º clique (dblclick), cancela o foco e deixa o rename.
    let clickTimer = null;
    li.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // 2º click do dblclick
      clickTimer = setTimeout(() => {
        clickTimer = null;
        window.trafficLight.focus({ pid: s.pid, windowid: s.windowid, focus_url: s.focus_url, tilix_id: s.tilix_id });
      }, 220);
    });

    const led = document.createElement('span');
    led.className = `led led--${st.level}`;

    const main = document.createElement('span');
    main.className = 'row__main';

    const labelEl = document.createElement('span');
    labelEl.className = 'row__label';
    const icon = document.createElement('span');
    icon.className = 'row__icon';
    icon.textContent = iconFor(st);
    labelEl.append(icon, label);
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // era clique simples pendente → cancela o foco
      startRename(s, labelEl);
    });

    const subEl = document.createElement('span');
    subEl.className = 'row__sub';
    subEl.textContent = sub;

    main.append(labelEl, subEl);
    li.append(led, main);

    // Snooze do alerta (só em vermelho): não apaga a cor, só cala o beep/notif.
    if (st.level === 'awaiting') {
      const sk = snoozeKey(s);
      const muted = isSnoozed(sk);
      const btn = document.createElement('button');
      btn.className = 'row__snooze' + (muted ? ' is-on' : '');
      btn.textContent = muted ? '🔕' : '🔔';
      btn.title = T(muted ? 'snooze_off' : 'snooze_on');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isSnoozed(sk)) snoozed.delete(sk);
        else snoozed.set(sk, Date.now() + SNOOZE_MS);
        render();
      });
      li.append(btn);
    }

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
  renderLauncher();
  $list.hidden = !expanded || sessions.length === 0;
  document.title = `ATL · ${sessions.length} ${T('doc_sessions')} · ${parts.join(' ')}`;
  autosize();
  firstRender = false;
}

// Barra persistente de Quick Launcher (rodapé do overlay): um botão-ícone por
// CLI detectado, com a marca/cor de cada agente. Visível sempre que houver
// launchers — não só no empty state.
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
    btn.title = '+ ' + a.label;
    // Ícone + label: o label desliza (max-width) no hover, formando uma pílula
    // "✦ Claude" animada. Sem hover, só o ícone (compacto, 26px).
    btn.innerHTML = '<span class="launcher-btn__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + a.mark + '</svg></span><span class="launcher-btn__label">' + a.label + '</span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.launchAgent({ agent: l.id }); });
    $bar.append(btn);
  }
  // Rodapé permanece visível sempre que há launchers — inclusive recolhido
  // (estado "só header + rodapé"). A altura da janela acompanha no setExpanded.
  $bar.hidden = launchers.length === 0;
}

function autosize() {
  if (!expanded) return;
  // Mede a posição NATURAL da última linha (ou do empty). offsetTop é relativo
  // ao .overlay (position:relative), já inclui o header. As linhas ficam no
  // topo do list, então essa posição é a natural — independe da altura flex
  // da janela (o que evita o loop de feedback que a fazia crescer sozinha).
  const $bar = document.getElementById('launcher');
  const launcherH = ($bar && !$bar.hidden) ? $bar.offsetHeight : 0;
  let bottom;
  if (sessions.length) {
    const last = $list.lastElementChild;
    bottom = last ? (last.offsetTop + last.offsetHeight + 10) : (HEADER_H + 40);
  } else {
    bottom = $empty.offsetTop + $empty.offsetHeight + 8;
  }
  window.trafficLight.autoHeight(bottom + launcherH + 4);
}

// Eventos de UI
$expand.addEventListener('click', () => setExpanded(!expanded));
$quit.addEventListener('click', () => window.trafficLight.toggleVisibility()); // × esconde (tray)
document.getElementById('settingsBtn').addEventListener('click', () => window.trafficLight.openSettings());

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
window.trafficLight.getAliases().then((a) => { aliases = a || {}; render(); });
window.trafficLight.getLaunchers().then((l) => { launchers = l || []; render(); });
window.trafficLight.getSettings().then((c) => { settingsCfg = c; render(); });
window.trafficLight.onSettingsChanged((c) => {
  settingsCfg = c;
  render();
  // o idioma pode ter mudado nas Preferências — re-resolve e re-aplica estáticos
  window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyStaticI18n(); render(); });
});

// Re-renderiza a cada 2s (escalada idle + reavaliação do alerta).
setInterval(render, 2000);

setExpanded(true);
render();
