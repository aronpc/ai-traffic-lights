// renderer.js — monta a lista suspensa a partir das sessões observadas.
// Estado (cor) via computeState() (state-machine.js, escopo global — não redeclarar).

let sessions = [];
let expanded = true;
let aliases = {};                          // cwd -> apelido
const prevLevels = new Map();              // pid -> level (detecção de transição p/ vermelho)
const lastAlert = new Map();               // pid -> ms (rate-limit do alerta)

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
  return 'claude · ' + s.pid;
}

function setExpanded(v) {
  expanded = v;
  $list.hidden = !v;
  $empty.hidden = !v || sessions.length > 0;
  $expand.textContent = v ? '▴' : '▾';
  window.trafficLight.setExpanded(v);
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
  window.trafficLight.notify(`⚠ ${AGENTS[agentOf(s)].label} precisa de você`, labelFor(s));
}

// ---- rename in-place ----
function startRename(s, labelEl) {
  if (!s.cwd) return;
  const input = document.createElement('input');
  input.className = 'row-input';
  input.value = aliases[s.cwd] || basename(s.cwd);
  labelEl.replaceChildren(input);
  input.focus(); input.select();
  const commit = () => {
    window.trafficLight.setAlias(s.cwd, input.value);
    aliases[s.cwd] = input.value.trim();
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { render(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

function render() {
  const nowSec = Math.floor(Date.now() / 1000);
  let worst = 'done';
  const tally = { processing: 0, done: 0, awaiting: 0 };

  const rows = sessions.map((s) => {
    const st = computeState(s, nowSec);
    tally[st.level]++;
    if (st.level === 'awaiting') worst = 'awaiting';
    else if (st.level === 'processing' && worst !== 'awaiting') worst = 'processing';

    // Alerta ao TRANSITAR pra vermelho (rate-limit 30s/sessão).
    const key = s.pid || s.session_id;
    const was = prevLevels.get(key);
    if (st.level === 'awaiting' && was !== 'awaiting') {
      const nowMs = Date.now();
      if (!lastAlert.has(key) || nowMs - lastAlert.get(key) > 30000) {
        lastAlert.set(key, nowMs);
        alertAwaiting(s);
      }
    }
    prevLevels.set(key, st.level);

    const label = labelFor(s);
    const sub = [
      AGENTS[agentOf(s)].label,               // qual agente (claude, gemini, ...)
      s.model,
      s.last_tool ? s.last_tool : (s.last_event || ''),
      ageText(nowSec, s.last_event_ts),
    ].filter(Boolean).join(' · ');

    const li = document.createElement('li');
    li.className = 'row';
    li.title = 'clique: focar terminal · duplo-clique: renomear';
    li.addEventListener('click', () => window.trafficLight.focus({ pid: s.pid, windowid: s.windowid, focus_url: s.focus_url }));

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
    labelEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(s, labelEl); });

    const subEl = document.createElement('span');
    subEl.className = 'row__sub';
    subEl.textContent = sub;

    main.append(labelEl, subEl);
    li.append(led, main);
    return li;
  });

  $list.replaceChildren(...rows);
  $summaryLed.className = `led led-summary led--${worst}`;

  const parts = [];
  if (tally.processing) parts.push(`🟡${tally.processing}`);
  if (tally.done) parts.push(`🟢${tally.done}`);
  if (tally.awaiting) parts.push(`🔴${tally.awaiting}`);
  $counts.textContent = sessions.length === 0 ? '—' : `${parts.join(' ')}  (${sessions.length})`;

  $empty.hidden = sessions.length > 0;
  if (sessions.length > 0 && expanded) $list.hidden = false;
  document.title = `ATL · ${sessions.length} sessões · ${parts.join(' ')}`;
  autosize();
}

function autosize() {
  if (!expanded) return;
  // Mede pelo fundo da última linha (offsetTop é relativo ao .overlay, já
  // inclui o header). scrollHeight não serve: nunca encolhe abaixo do
  // container — a janela crescia mas não voltava quando sessões fechavam.
  const last = $list.lastElementChild;
  const h = (sessions.length && last)
    ? last.offsetTop + last.offsetHeight + 10   // + padding inferior da lista
    : 58 + 56;                                  // header + estado vazio
  window.trafficLight.autoHeight(h);
}

// Eventos de UI
$expand.addEventListener('click', () => setExpanded(!expanded));
$quit.addEventListener('click', () => window.trafficLight.toggleVisibility()); // × esconde (tray)

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

// Recebe sessões; pede carga inicial; carrega apelidos.
window.trafficLight.onSessions((s) => { sessions = s || []; render(); });
window.trafficLight.requestSessions();
window.trafficLight.getAliases().then((a) => { aliases = a || {}; render(); });

// Re-renderiza a cada 2s (escalada idle + reavaliação do alerta).
setInterval(render, 2000);

setExpanded(true);
render();
