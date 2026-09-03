// renderer.js — builds the dropdown list from the observed sessions.
// State (color) via computeState() (state-machine.js, global scope — do not redeclare).

let sessions = [];
let expanded = true;
let renaming = false;                      // rename input open → suspends render()
let aliases = {};                          // sessionKey (session_id|pid) -> alias
let settingsCfg = null;                    // {idleThresholdSec, escalateIdle} from settings.json
let lastLangPref = null;                    // applied language pref ('auto'|'en'|'pt') — avoids re-resolving the language on every settings-changed (live-apply)
let T = makeT('en');                       // i18n — switches to the system language via get-lang
let firstRender = true;                    // hydrates prevLevels without alerting at boot
const seenOrigins = new Set();             // origins already seen (new peer = hydrates without beeping)
const prevLevels = new Map();              // pid -> level (red transition detection)
const lastAlert = new Map();               // pid -> ms (alert rate-limit)
const snoozed = new Map();                 // key -> ms (silences the ALERT until then; the color stays)
const readMarks = new Map();               // key -> ts (epoch s): session marked READ up to this event; > → gray
let everHadSessions = false;               // onboarding: shows "install hooks" only while there has never been a session
let launchers = [];                        // Quick Launcher: [{id,label}] of the detected CLIs
let usageEntries = [];                     // usage/reset: [{agent,title,usedPct,resetAt,resetInMin,extra,source,error}]
let appVersion = '';                       // app version (right footer)
let updateInfo = null;                     // {current,method,latest,hasUpdate,url,error} from GitHub
const SNOOZE_MS = 60 * 60 * 1000;          // 1h
function snoozeKey(s) { return sessionKey(s); }
// ROW identity for the persisted alias — never the cwd. Two terminals in the
// same directory are distinct rows (different session_id/pid) and must be
// able to have distinct names; indexing by cwd made renaming one rename all.
// session_id first: it is what Claude/Codex reuse in --resume and persist to
// disk, so the alias survives an app/session restart; pid is the fallback
// (headless procs, whose session_id is already `proc-<pid>`). String() for the IPC guard.
// aliasKey now lives in identity.js (the details window resolves aliases
// with the SAME key — divergence here = alias never matches across pages).
function isSnoozed(key) {
  const until = snoozed.get(key);
  if (!until) return false;
  if (Date.now() > until) { snoozed.delete(key); return false; } // expired — clean up
  return true;
}

const HEADER_H = 58; // must match --header-h in the CSS

const $list = document.getElementById('list');
const $empty = document.getElementById('empty');
const $counts = document.getElementById('counts');
const $usage = document.getElementById('usage');
const $ver = document.getElementById('verBtn');
const $toggleFooter = document.getElementById('toggleFooterBtn');
const $forceUsage = document.getElementById('forceUsageBtn');
const $summaryLed = document.getElementById('summaryLed');
const $expand = document.getElementById('expandBtn');
const $quit = document.getElementById('quitBtn');
const $groupBtn = document.getElementById('groupBtn');
const $search = document.getElementById('searchInput');
const $searchBtn = document.getElementById('searchBtn');

function basename(p) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}
// ageText now lives in i18n.js (the details window, details.js, needs the
// same "3min ago" — formatting is i18n's business, not the overlay's).
function labelFor(s) {
  const alias = aliases[aliasKey(s)];
  if (alias) return alias;
  if (s.cwd) return basename(s.cwd);
  return AGENTS[agentOf(s)].label.toLowerCase() + ' · ' + s.pid;
}

// Session from this machine? (remote comes from P2P sync and carries the peer's origin)
function isLocal(s) { return !s.origin || s.origin === 'local'; }

// Level dot for the per-host group header (#54) — same emojis as the header
// counter; read (gray) also appears because a block can be all read.
const LEVEL_DOT = { awaiting: '🔴', processing: '🟡', done: '🟢', read: '⚪' };

// The TWO ways to open a session — exposed as buttons on the row because the
// choice belongs to the user, not the app:
//   external → focuses the terminal where the session ALREADY runs (Warp/Tilix/…). Local only:
//              there is no way to focus another machine's window.
//   embedded → attaches tmux in an ATL terminal tab (xterm+pty). Requires
//              tmux_session; for remote it is the ONLY path (via WebSocket /pty).
function openExternal(s) {
  // `origin` is what blocks focusing a remote session in main (its pid is from
  // another kernel). Hints go as-is; main revalidates everything against
  // the live processes on click.
  window.trafficLight.focus({
    pid: s.pid, origin: s.origin, windowid: s.windowid,
    focus_url: s.focus_url, tilix_id: s.tilix_id, iterm_id: s.iterm_id, tmux_pane: s.tmux_pane,
  });
}

function openEmbedded(s) {
  const k = sessionKey(s);
  // labelFor = the SAME name the row shows (alias > cwd basename > agent·pid).
  // The tab inherits this name; it used to show 'tmux: <session>' — an internal
  // multiplexer id that says nothing and didn't match the list.
  window.trafficLight.attachRemote(s.origin || 'local', s.tmux_session, s.cwd, aliases[k] || '', k, labelFor(s));
}

function setExpanded(v) {
  expanded = v;
  // List disappears when collapsed (becomes just header + footer). It also hides
  // with 0 sessions: visible with 0 rows it flex-grows and pushes .empty down —
  // offsetTop would no longer be natural and autosize would enter a feedback loop.
  $list.hidden = !v || sessions.length === 0;
  $empty.hidden = !v || sessions.length > 0;
  $expand.classList.toggle('is-expanded', v);
  // Collapsed: the window shrinks to header + footer (the list disappears). The
  // footer (usage + launcher) only doesn't count when empty — then it's just the header.
  if (!v) {
    window.trafficLight.setExpanded(false, collapsedHeight());
  } else {
    window.trafficLight.setExpanded(true);
    autosize();
  }
}

// Height of the COLLAPSED state = header + visible footer (usage OR launcher). Only
// one of the two appears at a time (footerShowsUsage), so it adds the height of
// whichever is visible. Used when collapsing AND when toggling the footer while
// collapsed — otherwise the window kept the previous footer's space (bug: empty space below).
function collapsedHeight() {
  const $bar = document.getElementById('launcher');
  const $u = document.getElementById('usage');
  const launcherH = ($bar && !$bar.hidden) ? $bar.offsetHeight : 0;
  const usageH = ($u && !$u.hidden) ? $u.offsetHeight : 0;
  return HEADER_H + launcherH + usageH;
}

// ---- red alert: sound (Web Audio) + native notification ----
// The sound follows Preferences (settings.soundEnabled/soundVolume/soundType/
// soundFile): a synthetic preset (sound.js) or a user file decoded via Web Audio.
// The file is loaded on demand when the config changes.
let audioCtx = null;
let customBuffer = null;      // AudioBuffer of the decoded custom file
let customBufferFor = null;   // soundFile the buffer represents (avoids redecoding)
function ensureAudioCtx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// Fetches the custom file bytes (via IPC) and decodes them into an AudioBuffer.
// Idempotent: only redecodes if the path changed. Failure → no buffer (the beep
// falls back to the preset). Called when settingsCfg is applied/changes.
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
    if (cfg.soundEnabled === false) return;                        // sound off
    const ctx = ensureAudioCtx();
    const vol = typeof cfg.soundVolume === 'number' ? cfg.soundVolume : 0.18;
    if (cfg.soundType === 'custom' && customBuffer) { playBuffer(ctx, customBuffer, vol); return; }
    playPreset(ctx, cfg.soundType || 'beep', vol);                 // custom without a ready buffer → preset
  } catch {}
}
function alertAwaiting(s) {
  beep();
  window.trafficLight.notify('⚠ ' + T('needs_you', { agent: AGENTS[agentOf(s)].label }), labelFor(s));
}

// Static HTML texts (empty state, tooltips) in the system language.
// Tooltips are now customized (data-tip); i18n fills data-tip from
// data-i18n-tip (setupTooltips reads data-tip on hover).
function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-tip]')) el.setAttribute('data-tip', T(el.dataset.i18nTip));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', T(el.dataset.i18nPlaceholder));
}

// ---- row context menu (right click) ----
// Own menu in HTML (sibling of the list: survives the 2s re-render); the
// target session is captured in the items' closures. Copy via copy-text IPC
// (main validates the size before writing to the clipboard).
const $ctx = document.getElementById('ctxMenu');
let ctxBindings = null;                     // global listeners of the open menu
function closeCtx() {
  if (ctxBindings) {
    window.removeEventListener('mousedown', ctxBindings.onDown, true);
    window.removeEventListener('keydown', ctxBindings.onKey, true);
    window.removeEventListener('blur', ctxBindings.onBlur);
    ctxBindings = null;
  }
  if (!$ctx) return;
  $ctx.hidden = true;
  $ctx.textContent = '';                    // releases the target session's closures
}
function ctxItem(label, fn) {
  const it = document.createElement('div');
  it.className = 'ctx__item';
  it.textContent = label;
  it.addEventListener('click', (e) => { e.stopPropagation(); closeCtx(); fn(); });
  return it;
}
function openCtx(s, st, ev) {
  if (!$ctx) return;
  closeCtx();
  const isLcl = isLocal(s);
  const key = sessionKey(s);
  const copy = (t) => { if (window.trafficLight.copyText) window.trafficLight.copyText(String(t || '')); };

  // Copy the agent's SESSION_ID (the UUID `claude --resume` accepts), not the
  // ATL internal key (origin:pid) — that one only serves for read mark/snooze.
  // aliasKey prefers session_id; headless procs fall into `proc-<pid>`.
  $ctx.append(ctxItem(T('ctx_copy_key'), () => copy(aliasKey(s))));
  if (s.cwd) $ctx.append(ctxItem(T('ctx_copy_cwd'), () => copy(s.cwd)));
  // attach: the command only runs on the MACHINE where tmux exists — remote has none
  if (isLcl && s.tmux_session) $ctx.append(ctxItem(T('ctx_copy_attach'), () => copy('tmux attach -t ' + s.tmux_session)));

  const canRename = isLcl && aliasKey(s);          // rename is local-only (startRename rejects remote)
  const canMark = (!settingsCfg || settingsCfg.markReadOnClick !== false) && st.level === 'awaiting';
  // Details exists for any session (local and remote) → the separator is fixed
  const sep = document.createElement('div');
  sep.className = 'ctx__sep';
  $ctx.append(sep);
  // Details opens in its own standalone WINDOW (#59) — the overlay doesn't block
  // and the window updates live. Main is the one pushing the session data by key.
  $ctx.append(ctxItem(T('ctx_details'), () => window.trafficLight.openDetails(key)));
  // label resolved ON CLICK: the live labelEl is the one from the last render (the node
  // captured when opening the menu may have been replaced since then)
  if (canRename) $ctx.append(ctxItem(T('ctx_rename'), () => startRename(s, labelElFor(key))));
  if (canMark) $ctx.append(ctxItem(T('ctx_mark_read'), () => {
    const at = s.last_event_ts || Math.floor(Date.now() / 1000);
    readMarks.set(key, at);
    if (window.trafficLight.markRead) window.trafficLight.markRead(key, at, originOf(s));
    render();
  }));

  // positions at the cursor, clamped inside the window
  $ctx.hidden = false;
  const mw = $ctx.offsetWidth || 170, mh = $ctx.offsetHeight || 100;
  let x = ev.clientX + 2, y = ev.clientY + 2;
  if (x + mw > window.innerWidth - 6) x = Math.max(6, window.innerWidth - mw - 6);
  if (y + mh > window.innerHeight - 6) y = Math.max(6, window.innerHeight - mh - 6);
  $ctx.style.left = x + 'px';
  $ctx.style.top = y + 'px';

  // closes: mousedown outside (capture — before the row handlers), Esc, blur
  const onDown = (e) => { if (!$ctx.contains(e.target)) closeCtx(); };
  const onKey = (e) => { if (e.key === 'Escape') closeCtx(); };
  const onBlur = () => closeCtx();
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  ctxBindings = { onDown, onKey, onBlur };
}

// ---- session details ----
// The panel migrated to its own standalone WINDOW (#59 — src/details.html +
// src/details.js): it was previously a BLOCKING overlay modal with frozen data;
// now the ctx item calls trafficLight.openDetails(key) and main pushes the
// live session to the window on every refresh. Mounting/copy/timeline live in
// src/details.js (tested there — test/details.test.js).

// ---- rename in-place ----
// While the input is open, `renaming` suspends render() — otherwise the
// replaceChildren() of an idle tick (2s) or a session event
// would rip the input out of the DOM mid-typing (issue #2).
//
// The context menu survives render ticks: the labelEl captured at
// open-time may be DETACHED when the user finally clicks "Rename" — the
// input would mount on a node outside the list, `renaming` would stay on forever and
// render() would freeze. The menu resolves the LIVE label on click: labelEls is
// rebuilt on every render with the nodes that are in the list now.
const labelEls = new Map();                     // sessionKey → label node from the last render
function labelElFor(key) { return labelEls.get(key) || null; }
function startRename(s, labelEl) {
  const key = aliasKey(s);
  if (!key || renaming) return;
  if (s.origin && s.origin !== 'local') return;   // remote row: rename is local-only (doesn't sync)
  if (!labelEl) return;                           // session left the list between opening the menu and clicking
  renaming = true;
  const input = document.createElement('input');
  input.className = 'row-input';
  input.value = aliases[key] || (s.cwd ? basename(s.cwd) : '');
  labelEl.replaceChildren(input);
  input.focus(); input.select();

  // finish() is idempotent (`done`): when committing via Enter, the next
  // render() removes the input and fires a blur — which must NOT re-save
  // (and on Escape, never save the typed text).
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
  input.addEventListener('blur', () => finish(true));   // click outside = commit
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Rename of the Claude ACCOUNT (multi-account #58): dblclick on the bar's name changes
// the displayed alias. Same contract as the session rename (reuses the `renaming` flag
// → render() doesn't destroy the input), but persists via set-account-label — main
// resolves the accountId (sfx) back to the uuid and writes account-labels.json.
function startAccountRename(u, nameEl) {
  if (!u.accountId || renaming) return;
  renaming = true;
  const input = document.createElement('input');
  input.className = 'row-input';
  input.value = u.account || '';
  nameEl.replaceChildren(input);
  input.focus(); input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = false;
    if (save && input.value.trim() !== (u.account || '')) {
      u.account = input.value.trim() || undefined;   // optimistic: label changes right away
      window.trafficLight.setAccountLabel(u.accountId, input.value);
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));   // click outside = commit
  input.addEventListener('click', (e) => e.stopPropagation());
}

function render() {
  if (renaming) return;                    // doesn't destroy the open input (issue #2)
  const nowSec = Math.floor(Date.now() / 1000);
  let worst = 'done';
  const tally = { processing: 0, done: 0, awaiting: 0, read: 0 };
  const markRead = !settingsCfg || settingsCfg.markReadOnClick !== false;

  // Origins appearing for the 1st time in this render (new origins = peer just
  // connected). Their sessions are HYDRATED (prevLevels seeded) — doesn't beep
  // everything at once when a peer joins; only future transitions trigger the alert.
  const newOrigins = new Set();
  for (const s of sessions) { const o = s.origin || 'local'; if (!seenOrigins.has(o)) newOrigins.add(o); }

  // 1. compute each session's state (+ tally/worst in the same pass).
  const ranked = sessions.map((s) => {
    const key = sessionKey(s);
    // readAt only counts if the feature is on; otherwise computeState ignores it.
    const readAt = markRead ? readMarks.get(key) : undefined;
    const st = computeState(s, nowSec, settingsCfg, readAt);
    tally[st.level]++;
    if (st.level === 'awaiting') worst = 'awaiting';
    else if (st.level === 'processing' && worst !== 'awaiting') worst = 'processing';

    // Alert on TRANSITION to red (30s/session rate-limit). On the 1st render
    // it only hydrates prevLevels — a session that was ALREADY red when the app
    // opened must not beep (only real transitions trigger the alert). A session marked
    // read is in 'read' (not 'awaiting'), so it doesn't beep — it relights only on
    // a new red event (which returns it to 'awaiting' and passes through here).
    // 1st appearance of a REMOTE origin: seeds prevLevels to avoid bursting
    // alerts on sessions that were ALREADY red when the peer arrived. The boot's
    // local load is covered by firstRender; later local sessions are not.
    if (s.origin && s.origin !== 'local' && newOrigins.has(s.origin)) prevLevels.set(key, st.level);
    const was = prevLevels.get(key);
    if (!firstRender && st.level === 'awaiting' && was !== 'awaiting' && !isSnoozed(key)) {
      const nowMs = Date.now();
      if (!lastAlert.has(key) || nowMs - lastAlert.get(key) > 30000) {
        lastAlert.set(key, nowMs);
        alertAwaiting(s);
        if (settingsCfg.revealOnRed) window.trafficLight.revealOverlay(); // brings to front if hidden
      }
    }
    prevLevels.set(key, st.level);
    return { s, st };
  });
  for (const s of sessions) seenOrigins.add(s.origin || 'local'); // registers the origins seen

  // Cleans up per-session state of dead sessions (avoids growing unbounded
  // in long use). readMarks/prevLevels/lastAlert/snoozed are keyed by
  // pid||session_id; any key outside the live set is garbage.
  const liveKeys = new Set(sessions.map((s) => sessionKey(s)));
  for (const m of [readMarks, prevLevels, lastAlert, snoozed]) {
    for (const k of m.keys()) if (!liveKeys.has(k)) m.delete(k);
  }
  // Prunes from seenOrigins the origins that disappeared (sync off / peer removed).
  // Without this, on re-enabling sync the remote origins would still be in seenOrigins
  // → they wouldn't enter newOrigins → prevLevels wouldn't be seeded → ALL
  // reds would fire alertAwaiting() at once (sound + native notification),
  // without the lastAlert rate-limit (which was also pruned). The very anti-burst
  // protection failed exactly on reconnection. readMarks turn red again on
  // re-enable, but the alert BURST — the High bug — is gone (PR-32 #19).
  const liveOrigins = new Set(sessions.map((s) => s.origin || 'local'));
  for (const o of seenOrigins) if (!liveOrigins.has(o)) seenOrigins.delete(o);

  // 2. Search (#55): filters BEFORE sorting — the urgency order of what remains
  // is preserved (search only hides, never reorders; issue requirement).
  // tally/worst/tray/alerts keep the TOTAL: search is a VISUAL slice —
  // a red outside the filter still counts in the tray and fires the alert.
  // The #54 groups work out on their own: groupBreaks runs over the already
  // filtered list, so hosts with no match don't even get a header.
  const q = searchQuery();
  const visible = q ? ranked.filter(({ s }) => sessionMatches(q, s, labelFor(s))) : ranked;

  // sorts by urgency: 🔴 on top, then 🟡, then 🟢 (state-machine.js).
  // In grouped mode (#54) ORIGIN becomes the primary key (contiguous blocks) and
  // urgency sorts WITHIN the block — with primary urgency a 🔴 peer would land
  // in the middle of the local rows and fragment the host's block.
  const ordered = sortByUrgency(visible, { originFirst: groupByHostOn() });

  // Grouping by host (#54): with the toggle on AND >1 origin block, a
  // li.group-header opens each block (the sort above already leaves hosts
  // contiguous: local first, peers alphabetical) and the row's origin badge
  // goes away — the header already says where it comes from. 1 host only: no header, with badge — the
  // single remote keeps identifying itself (identical to today).
  const breaks = groupByHostOn() ? groupBreaks(ordered) : [];
  const grouped = breaks.length > 1;
  const breakAt = new Map(grouped ? breaks.map((b) => [b.startIdx, b]) : []);

  // 3. builds the rows in the sorted order.
  labelEls.clear();                            // only nodes of the LIVE list (menu resolves through here)
  const rows = [];
  ordered.forEach(({ s, st }, idx) => {
    const brk = breakAt.get(idx);
    if (brk) {
      const hdr = document.createElement('li');
      hdr.className = 'group-header';
      hdr.textContent = `${brk.origin} · ${brk.count} ${LEVEL_DOT[brk.worst] || ''}`.trim();
      rows.push(hdr);
    }
    const label = labelFor(s);
    const key = sessionKey(s);     // to mark as read on click
    const agent = AGENTS[agentOf(s)];
    // Text to the right of the name: model · tool · time (the LLM icon on the
    // left already tells the agent; the model distinguishes the variant — glm-5.2, gpt-5).
    const sub = [
      s.model,
      s.last_tool ? s.last_tool : (s.last_event || ''),
      ageText(nowSec, s.last_event_ts),
    ].filter(Boolean).join(' · ');

    const li = document.createElement('li');
    li.className = 'row';
    li.setAttribute('data-tip', T('row_tooltip'));
    // Single click = focus terminal; but dblclick (rename) fires 2 clicks
    // first — without debounce, each click raises the terminal and steals keyboard
    // focus from the rename input, which opens empty/closes immediately. Fix: wait
    // 220ms; if a 2nd click comes (dblclick), cancel the focus and let the rename happen.
    let clickTimer = null;
    li.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // 2nd click of the dblclick
      // Mark as read: the SAME click focuses AND silences the red (turns gray)
      // — stamps up to the current event; a new notification (larger ts) relights it.
      if (markRead && st.level === 'awaiting') {
        const at = s.last_event_ts || nowSec;
        readMarks.set(key, at);
        // #56: main persists the mark and, if the session belongs to a PEER, posts it
        // to the origin (readAt anchored to the local clock + now) so everyone sees gray.
        if (window.trafficLight.markRead) window.trafficLight.markRead(key, at, originOf(s));
        render();                            // reflects the gray immediately
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        // LOCAL session: the click focuses the terminal WHERE IT ALREADY RUNS (Warp/Tilix/…).
        // Before, any session with tmux_session was attached in the embedded terminal
        // — the click stopped focusing the original terminal, which is the expected
        // behavior. Opening in the ATL terminal became an explicit option (⧉ button).
        // REMOTE: there is no local window to focus → embedded attach (or panel).
        if (isLocal(s)) openExternal(s);
        else if (s.tmux_session) openEmbedded(s);
        else openTranscriptPanel(s);
      }, 220);
    });

    // Right click → context menu (copy key/cwd/attach, rename,
    // mark as read). preventDefault holds back Chromium's native menu.
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(s, st, e);
    });

    // Fixed columns (aligned across rows): [led] [reason] [LLM] [name…] [text] [bell]
    const led = document.createElement('span');
    led.className = `led led--${st.level}`;

    // reason icon (🔑 permission, 🛠 tool, ✓ ok, ⚠ error, ⏰ idle…)
    const reason = document.createElement('span');
    reason.className = 'row__reason';
    reason.textContent = iconFor(st);

    // LLM/CLI icon (brand SVG, agent color) — shows WHICH agent
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
    labelEls.set(key, labelEl);               // live for the context menu rename
    labelEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // was a pending single click → cancel the focus
      startRename(s, labelEl);
    });

    const subInline = document.createElement('span');
    subInline.className = 'row__sub-inline'; // model · tool · time on the same line as the name
    subInline.textContent = sub;
    // Click on the sub-text (model · tool · time) opens the "view prompt" panel
    // ONLY for remote (local: lets the click bubble up and focuses the real terminal —
    // the panel only makes sense where focusing isn't possible).
    const openTs = (e) => {
      if (!(s.origin && s.origin !== 'local')) return;   // local: click bubbles up → focus
      e.stopPropagation();
      openTranscriptPanel(s);
    };
    subInline.addEventListener('click', openTs);
    subInline.title = T('ts_see_prompt');

    // Origin badge on REMOTE sessions (which machine/peer it came from). Disappears
    // when the list is grouped by host (#54) — the block header already says it.
    if (!grouped && s.origin && s.origin !== 'local') {
      const badge = document.createElement('span');
      badge.className = 'row__origin';
      badge.textContent = s.origin;
      main.append(badge);
    }
    main.append(labelEl, subInline);
    li.append(led, reason, llm, main);

    // Actions column: ONLY the path the row click doesn't take. The click already
    // opens the default for each session type (external for local, embedded for
    // remote), and a button repeating that is noise — the whole row is already the
    // target, and it's bigger. One case is left: LOCAL session with tmux, where the row focuses
    // the original terminal and ⧉ is the other path.
    const actions = document.createElement('span');
    actions.className = 'row__actions';
    const mkAction = (glyph, tipKey, fn) => {
      const b = document.createElement('button');
      b.className = 'row__action';
      b.textContent = glyph;
      b.setAttribute('data-tip', T(tipKey));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(s); });
      return b;
    };
    // ⧉ ATL terminal: requires tmux (the attach is `tmux attach -t <session>`)
    // AND being local — on remote the row click ALREADY opens the embedded one, because
    // there is no local window to focus.
    if (isLocal(s) && s.tmux_session) actions.append(mkAction('⧉', 'row_open_embedded', openEmbedded));
    li.append(actions);

    // Alert snooze (red only): doesn't clear the color, only silences the beep/notif.
    // The column only exists when there IS a bell: the wrap stays empty on the other rows
    // and the CSS (:empty) removes it — reserving it left a dead gap on the right.
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

    rows.push(li);
  });

  $list.replaceChildren(...rows);
  $summaryLed.className = `led led-summary led--${worst}`;

  // Grouping toggle (#54): only makes sense with a live remote session — 1 host
  // has nothing to group and without sync the button doesn't even appear.
  if ($groupBtn) {
    $groupBtn.hidden = !sessions.some((s) => s.origin && s.origin !== 'local');
    $groupBtn.classList.toggle('is-on', grouped);
  }

  const parts = [];
  if (tally.processing) parts.push(`🟡${tally.processing}`);
  if (tally.done) parts.push(`🟢${tally.done}`);
  if (tally.awaiting) parts.push(`🔴${tally.awaiting}`);
  // With an active search the counter becomes "visible/total" — without this "🟢3" with one
  // row on screen looks like a bug; with the pair it's clear it's a filter.
  $counts.textContent = sessions.length === 0 ? '—'
    : (q ? `${visible.length}/${sessions.length}` : parts.join(' '));

  // Dynamic tray: the icon paints with the worst color and the tooltip carries the count.
  window.trafficLight.setTrayLevel({ level: worst, awaiting: tally.awaiting, processing: tally.processing, done: tally.done });

  // Onboarding: only while a session has NEVER appeared (sign of hooks not installed).
  // As soon as the 1st session shows up, the banner disappears for good in this run.
  everHadSessions = everHadSessions || sessions.length > 0;
  // With search: the empty state appears when the FILTER zeroes out (sessions exist, nothing
  // matches) — and the text is the search one, not onboarding (hooks are already installed
  // if we got here). Without search, the usual behavior.
  $empty.hidden = q ? visible.length > 0 : sessions.length > 0;
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
  } else if (q && !visible.length) {
    $empty.textContent = T('search_empty');
  }
  // Footer: usage OR launcher (never both) per settings.showUsage.
  renderUsage();
  renderLauncher();
  $list.hidden = !expanded || visible.length === 0;
  document.title = `ATL · ${sessions.length} ${T('doc_sessions')} · ${parts.join(' ')}`;
  autosize();
}

// Persistent Quick Launcher bar (overlay footer): one icon button per
// detected CLI, with each agent's brand/color. Visible whenever there are
// launchers — not only in the empty state.
// ---- agent usage/reset (band in the footer, one row per limit) ----
// Each row: [clickable agent icon] [name/plan] .... [%] [fixed bar] [reset].
// Clickable icon only if the agent is a detected launcher (Claude/Gemini/...);
// GLM is a backend, not launched → decorative icon. Bar always present
// (standardized size); empty % shows "—". Reset in local time (HH:MM),
// "+Nd HH:MM" if beyond today, "Xmin" if <1h. Re-render every 2s.
// ---- label of a usage row: always "Provider(Plan) window" ----
// Each row is autonomous (repeats the provider); before, the 2nd row of the same
// plan was left without a provider, looking like another agent (the "2 GLM without z.ai" bug).
const USAGE_PROVIDER = { claude: 'Claude', glm: 'z.ai', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' };
function usagePlanName(u) {
  const plan = u.plan || '';
  if (!plan) return '';
  if (u.agent === 'claude') return plan.replace(/^Claude\s+/, '');
  if (u.agent === 'codex') return plan.replace(/^Codex\s+/, '');
  if (u.agent === 'glm') return plan.replace(/^GLM\s+/, '').replace(/\s*\(z\.ai\)\s*$/, '');
  if (u.agent === 'antigravity') return plan.replace(/^Antigravity\s*\(/, '').replace(/\)\s*$/, '');
  if (u.agent === 'opencode') return plan.replace(/^OpenCode\s*/i, '').replace(/\s*\([a-f0-9]{6}\)$/, '');
  return plan;
}
function usageWindow(u) {
  if (u.agent === 'antigravity') return '';                  // label only, no window
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
  // Claude multi-account (#58): the account label distinguishes the bars —
  // "Claude(Max 5× · ghost)". Only the alias/identity appears; uuid and email
  // never reach the renderer (main resolves everything).
  const planFull = plan && u.account ? `${plan} · ${u.account}` : (plan || u.account || '');
  const head = planFull ? `${provider}(${planFull})` : provider;
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
    return `${hh}:${mm}`; // Shows the reset time if it's within the next 24h
  }

  const diffDays = Math.round(diffMs / 86400000);
  return `${diffDays}d`;
}
// Appearance (Preferences): panel transparency via --bg-alpha. Applied live
// (boot + settings-changed), no restart — the CSS already derives --bg from
// --bg-alpha. autosize recalculates the height.
function applyAppearance() {
  const op = settingsCfg && typeof settingsCfg.opacity === 'number' ? settingsCfg.opacity : 0.97;
  document.documentElement.style.setProperty('--bg-alpha', String(Math.max(0.6, Math.min(1, op))));
  autosize();
}

// Footer mode: showUsage (settings) decides whether the USAGE bar or the
// LAUNCHER bar shows — only one at a time. Default true (usage). The header toggle
// switches and persists it via save-settings.
function footerShowsUsage() {
  return !settingsCfg || settingsCfg.showUsage !== false;
}
// Group by host (#54): default ON (mergeWithDefaults); the header toggle
// switches and persists it in settings.groupByHost via persistUI.
function groupByHostOn() {
  return !settingsCfg || settingsCfg.groupByHost !== false;
}
function applyFooterMode() {
  const showUsage = footerShowsUsage();
  renderUsage();
  renderLauncher();
  // Real visibility is decided inside each render (they may be empty),
  // but the mode hides the other one for good.
  const $l = document.getElementById('launcher');
  if (showUsage) { if ($l) $l.hidden = true; }
  else { if ($usage) $usage.hidden = true; }
  if ($toggleFooter) $toggleFooter.classList.toggle('is-on', !showUsage); // highlights in launcher mode
  // Re-measures the height: expanded → autosize; collapsed → new footer's height
  // (autosize is a no-op when collapsed, so the window kept the previous
  // footer's space — empty space was left when switching usage↔launcher while collapsed).
  if (expanded) autosize();
  else window.trafficLight.setExpanded(false, collapsedHeight());
}

// Usage band = panel of meters. Each limit is a "channel": icon · name ·
// meter (track + fill that lights up) · readout (big %) · reset. The
// CSS Grid lives in the CONTAINER (.usage-bar) with shared columns, so
// ALL rows align on the same columns — identical tracks, reset with
// equal space — regardless of text. Each .urow is display:contents so
// its children land directly on the parent's grid.
function renderUsage() {
  if (!$usage) return;
  if (!footerShowsUsage() || !usageEntries.length) { $usage.hidden = true; $usage.replaceChildren(); return; }
  const launchable = new Set(launchers.map((l) => l.id));
  // Each row is autonomous: "Provider(Plan) window" — always shows the provider
  // (before, the 2nd row of the same plan was left without a provider, looking like
  // another agent). Provider/Plan/Window derived from the collector's fields (usageLabel).
  const rows = usageEntries.map((u) => {
    const a = AGENTS[u.agent] || { label: u.title || u.agent, color: 'rgba(255,255,255,0.3)' };
    // stale (old value, collector not updated for a few min) → gray, without
    // erasing the number; the value stays visible, just signals it's old.
    const lvl = u.stale ? 'none' : pctLevel(u.usedPct);
    const reset = resetClock(u.resetAt, u.resetInMin);
    const nameTxt = usageLabel(u);
    const hasPct = u.usedPct != null;

    const row = document.createElement('div');
    row.className = `urow urow--${lvl}` + (u.stale ? ' urow--stale' : '');
    row.style.setProperty('--agent-color', a.color || 'rgba(255,255,255,0.3)');
    row.style.setProperty('--pct', (hasPct ? u.usedPct : 0));
    // full tooltip (the .urow is display:contents/boxless → goes on .name).
    const tipTxt = [nameTxt, hasPct ? u.usedPct + '%' : null,
      reset ? 'reset ' + reset : null, u.stale ? 'sem atualizar' : null, u.extra, u.error].filter(Boolean).join(' · ');

    // icon: clickable button (launches the agent) if it's a launcher; decorative span otherwise.
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
    // Multi-account (#58): dblclick on the name = account alias (persisted in main).
    if (u.accountId) name.addEventListener('dblclick', () => startAccountRename(u, name));

    // readout: big number (band color) + small % sign; "—" when there's no data.
    const read = document.createElement('span'); read.className = 'urow__read';
    if (hasPct) {
      const num = document.createElement('b'); num.className = 'urow__num'; num.textContent = u.usedPct;
      const sign = document.createElement('span'); sign.className = 'urow__sign'; sign.textContent = '%';
      read.append(num, sign);
    } else {
      const dash = document.createElement('b'); dash.className = 'urow__num urow__num--empty'; dash.textContent = u.error ? '⚠' : '—';
      read.append(dash);
    }

    // meter: track (channel) + fill (width via --pct) with a brightness cap.
    const meter = document.createElement('span'); meter.className = 'urow__meter';
    const fill = document.createElement('i'); fill.className = 'urow__fill'; meter.append(fill);

    // reset: column ALWAYS present (keeps the space equal even when empty).
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
    // Icon + label: the label slides in (max-width) on hover, forming an animated
    // "✦ Claude" pill. Without hover, just the icon (compact, 26px).
    btn.innerHTML = '<span class="launcher-btn__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + a.mark + '</svg></span><span class="launcher-btn__label">' + a.label + '</span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.launchAgent({ agent: l.id }); });
    $bar.append(btn);
  }
  // Launcher only shows when the footer mode is NOT usage and there are launchers.
  $bar.hidden = footerShowsUsage() || launchers.length === 0;
}

// Version + update in the HEADER (left of the gear). No update: discreet
// "vX.Y.Z" text. With update: becomes a green "↑ vNEW" button that opens the release.
function renderVersion() {
  if (!$ver) return;
  if (!appVersion && !updateInfo) { $ver.hidden = true; return; }
  const u = updateInfo || {};
  // status: idle | available | downloading | ready | error  (fail-soft falls into available/idle)
  const status = u.status || (u.hasUpdate ? 'available' : 'idle');
  const method = u.method || '';
  const arrowSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  $ver.hidden = false;
  $ver.classList.toggle('has-update', status === 'available' || status === 'ready');
  if (status === 'available') {
    if (u.canAutoInstall) {                                  // AppImage: downloads + installs
      $ver.innerHTML = '↓ v' + u.latest;
      $ver.setAttribute('data-tip', T('update_download', { v: u.latest, method }));
    } else {                                                 // other methods: opens the release
      $ver.innerHTML = arrowSvg + 'v' + u.latest;
      $ver.setAttribute('data-tip', T('update_available', { v: u.latest, method }));
    }
  } else if (status === 'downloading') {
    $ver.innerHTML = '↓ ' + (u.progress || 0) + '%';
    $ver.setAttribute('data-tip', T('update_downloading', { p: (u.progress || 0) }));
  } else if (status === 'ready') {
    $ver.innerHTML = '↻ v' + u.latest;                       // restart to install
    $ver.setAttribute('data-tip', T('update_ready', { v: u.latest }));
  } else {
    $ver.textContent = 'v' + (appVersion || '?');            // idle / error → discreet
    if (method) $ver.setAttribute('data-tip', T('installed_via', { method })); else $ver.removeAttribute('data-tip');
  }
}

function autosize() {
  if (!expanded) return;
  // Measures the NATURAL position of the last row (or of the empty state). offsetTop is
  // relative to the .overlay (position:relative), already includes the header. Rows sit at the
  // top of the list, so this position is the natural one — independent of the window's
  // flex height (which avoids the feedback loop that made it grow on its own).
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

// Persists UI state (footer + collapsed) without showing it in Preferences —
// writes the current keys to settings.json via save-settings. Called when the
// user toggles the footer or collapses/expands the window.
function persistUI(patch) {
  settingsCfg = { ...(settingsCfg || {}), ...patch };
  window.trafficLight.saveSettings(settingsCfg); // main re-emits settings-changed
}

// UI events
$expand.addEventListener('click', () => {
  setExpanded(!expanded);
  persistUI({ collapsed: !expanded });           // remembers collapsed/expanded
});
$quit.addEventListener('click', () => window.trafficLight.toggleVisibility()); // × hides (tray)
document.getElementById('settingsBtn').addEventListener('click', () => window.trafficLight.openSettings());

// FOOTER toggle (header): switches usage ⇄ launcher and persists in settings.showUsage.
if ($toggleFooter) $toggleFooter.addEventListener('click', () => {
  persistUI({ showUsage: !footerShowsUsage() });
  applyFooterMode();
});
// Group by host (#54): toggles the machine headers and persists.
if ($groupBtn) $groupBtn.addEventListener('click', () => {
  persistUI({ groupByHost: !groupByHostOn() });
  render();
});
// ---- fuzzy search (#55) ----
// The input lives in the HEADER (render only remounts $list) — the value and focus
// survive any 2s re-render without an extra flag, unlike the rename input
// which is born inside the list and needs the `renaming` guard.
function searchQuery() {
  if (!$search || $search.hidden) return '';
  return ($search.value || '').trim();
}
function setSearchOpen(open) {
  if (!$search) return;
  if (!open) $search.value = '';          // closing clears it — search is ephemeral state
  $search.hidden = !open;
  if ($searchBtn) $searchBtn.classList.toggle('is-on', open);
  // Search mode: the whole header becomes the input. On a narrow overlay the
  // spacer space between counts and buttons is minimal — with the class, the header
  // noise (divider, counts and the middle buttons) collapses via CSS and the input expands.
  const bar = $search.closest('.bar');
  if (bar) bar.classList.toggle('bar--searching', open);
  if (open) $search.focus();
  else render();                          // filter gone → the full list comes back
}
if ($searchBtn) $searchBtn.addEventListener('click', () => setSearchOpen($search.hidden));
if ($search) {
  $search.addEventListener('input', () => render());
  $search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSearchOpen(false); }
  });
}
// `/` or Ctrl+F open the search from anywhere in the overlay. Ignores when already
// typing (rename input / the search itself: `/` in it is text).
window.addEventListener('keydown', (e) => {
  if (!$search || !$search.hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === '/' || ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();                   // otherwise the slash would land in the input
    setSearchOpen(true);
  }
});
// Force (⟳): re-collects usage on the spot (bypasses the convenience cache; the
// 429 cooldown is still respected in main). Spins the icon ~600ms as feedback — the
// 'usage' push arrives right after and re-renders the tiles.
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
  // Blocked during the 429 cooldown: re-collecting wouldn't bring a new % (the collector
  // respects the cooldown) and the spinner would give a false impression of updating. The
  // tooltip already explains "wait Xmin"; here it just doesn't trigger anything.
  if (claudeCooldownUntil > Date.now()) return;
  window.trafficLight.forceUsage();
  $forceUsage.classList.add('is-spinning');
  setTimeout(() => $forceUsage.classList.remove('is-spinning'), 600);
});

// Version button: branches by state. available → download (AppImage) or open
// the release (others); ready → restart and install; idle/error → "check now".
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

// Resize gripper (width).
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

// Receives sessions; requests the initial load; loads language, aliases and settings.
window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyStaticI18n(); render(); });
window.trafficLight.onSessions((s) => {
  sessions = s || [];
  render();
  // Only the first REAL session load ends hydration. Earlier renders
  // fired by language/settings must not consume the boot anti-alert guard.
  firstRender = false;
});
// Read marks (#56): boot = the full state from main (survives restart);
// live = one mark per peer POST /read. LWW in both: only goes up, never
// downgrades a more recent "read" already in the Map.
if (window.trafficLight.onReadMarks) window.trafficLight.onReadMarks((state) => {
  let changed = false;
  for (const [k, at] of Object.entries(state || {})) {
    if (at > (readMarks.get(k) || 0)) { readMarks.set(k, at); changed = true; }
  }
  if (changed) render();
});
if (window.trafficLight.onRemoteRead) window.trafficLight.onRemoteRead(({ key, readAt } = {}) => {
  if (!key || !(readAt > 0)) return;
  if (readAt > (readMarks.get(key) || 0)) { readMarks.set(key, readAt); render(); }
});
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
  if (c && c.soundType === 'custom') loadCustomSound(c.soundFile);  // pre-loads the custom audio
  // Restores the saved UI state: collapsed/expanded (default expanded).
  setExpanded(!(c && c.collapsed));
  applyAppearance();                       // panel transparency
  applyFooterMode();
  render();
});
window.trafficLight.onSettingsChanged((c) => {
  const langChanged = !c || c.lang !== lastLangPref;  // only re-resolves the language if the PREF changed
  lastLangPref = c && c.lang;
  settingsCfg = c;
  loadCustomSound(c && c.soundType === 'custom' ? c.soundFile : null); // reloads/clears the custom audio
  applyAppearance();                       // opacity/compact may have changed
  applyFooterMode();                       // footer may have changed (showUsage)
  render();
  // the language may have changed in Preferences — re-resolve and re-apply statics.
  // Guarded: in live-apply this fires on every change (e.g. opacity drag);
  // getLang()+applyStaticI18n()+render() on every tick would cause jank and a double re-render.
  if (langChanged) {
    window.trafficLight.getLang().then((l) => { T = makeT(l || 'en'); applyStaticI18n(); render(); });
  }
});

// Re-renders every 2s (idle escalation + alert re-evaluation).
setInterval(render, 2000);

// Custom tooltips: a single listener on the overlay (delegation) covers the header,
// usage rows, launcher — including elements created later. setupTooltips
// is global (src/tooltip.js). Guarded by typeof so it doesn't break in tests.
if (typeof setupTooltips === 'function') {
  const $ov = document.getElementById('overlay');
  const $tip = document.getElementById('tooltip');
  if ($ov && $tip) setupTooltips($ov, $tip, { delay: 380 });
}

// Initial state before getSettings resolves: expanded (the saved settings
// overwrite it as soon as they arrive). Without this the 1st paint has no defined size.
setExpanded(true);
render();

// ---- "view prompt" panel (transcript) — phase 3 ----
// Opens on a click on the row's sub-text. Fetches the last N messages on
// demand (local reads disk; remote via /transcript on the peer) — never in the poll.
// textContent for the message text (no HTML injection coming from the prompt).
let $tsPanel = null;
let transcriptRequestSeq = 0;
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
  const requestSeq = ++transcriptRequestSeq;
  window.trafficLight.fetchTranscript(s.origin || 'local', s.session_id, 20)
    .then((msgs) => {
      if (requestSeq !== transcriptRequestSeq) return;
      if (!Array.isArray(msgs) || !msgs.length) { body.innerHTML = '<div class="ts-empty">' + T('ts_empty') + '</div>'; return; }
      body.innerHTML = '';   // clears the "loading"
      for (const m of msgs) {
        const row = document.createElement('div');
        row.className = 'ts-msg ts-' + m.role;
        const role = document.createElement('span'); role.className = 'ts-role'; role.textContent = m.role;
        const text = document.createElement('span'); text.className = 'ts-text'; text.textContent = m.text;
        row.append(role, text);
        body.appendChild(row);
      }
    })
    .catch(() => {
      if (requestSeq !== transcriptRequestSeq) return;
      body.innerHTML = '<div class="ts-empty">' + T('ts_error') + '</div>';
    });
}

// (the embedded terminal moved to src/term.html + src/term-renderer.js —
// opened in its own maximizable window by ensureTermWin() in main. The click
// on a session still calls window.trafficLight.attachRemote at :284.)
