// details.js — session details card + bootstrap for the standalone details
// window (details.html). Extracted from renderer.js when the panel stopped
// being a blocking modal of the overlay (#59): it now lives in its own
// BrowserWindow, doesn't block the list and updates LIVE (main pushes the
// session on every refresh). Dual browser/Node module (fuzzy.js pattern) —
// tests load it in a vm with a DOM mock, without the whole renderer.
//
// Structure: mountDetails(root, s, ctx) fills .dt-title and .dt-body with the
// same section/row layout as before — but INCREMENTALLY: every node carries a
// stable key and is reused across pushes, so a live refresh updates values in
// place instead of rebuilding the card. Rebuilding would reset transient UI
// state the user just set (expanded timeline, text selection) every 2-5s,
// which is exactly the state the window exists to monitor. initDetailsWindow
// (api) is the page bootstrap: listens for the 'details-data' push from main,
// mounts, and wires Esc/× to the 'details-close' IPC.

function basename(p) {
  return String(p || '').replace(/\/+$/, '').split('/').pop() || '';
}

// Session label (same logic as the overlay row: alias > folder > agent·pid).
// Receives the aliases map — whoever calls owns the state.
function labelFor(s, aliases) {
  const alias = aliases[aliasKey(s)];
  if (alias) return alias;
  if (s.cwd) return basename(s.cwd);
  return (AGENTS[agentOf(s)] || { label: agentOf(s) }).label.toLowerCase() + ' · ' + s.pid;
}

// First direct child carrying the given data-key, or null.
function findKeyed(parent, key) {
  for (const c of parent.children) {
    if (c.getAttribute && c.getAttribute('data-key') === key) return c;
  }
  return null;
}

// Reconciles `parent` children to exactly the ordered `specs` list
// ({key, el}), reusing existing nodes by key: a child stays only when it IS
// the spec's element for its key (identity, not just key — a rebuilt node
// with a reused key must evict the old one), then the spec order is enforced
// by moving/inserting only what is out of place.
function syncChildren(parent, specs) {
  const byKey = new Map(specs.map((sp) => [sp.key, sp.el]));
  for (const child of [...parent.children]) {
    const key = child.getAttribute && child.getAttribute('data-key');
    if (byKey.get(key) !== child) child.remove();
  }
  specs.forEach((sp, i) => {
    if (parent.children[i] !== sp.el) {
      parent.insertBefore(sp.el, parent.children[i] || null);
    }
  });
}

function dtSec(key, title) {
  const h = document.createElement('div');
  h.className = 'dt-sec';
  h.setAttribute('data-key', key);
  h.textContent = title;
  h._kind = 'sec';
  h._update = (t) => { if (h.textContent !== t) h.textContent = t; };
  return h;
}

function dtRow(key, label, value, copyText, T, copy) {
  const row = document.createElement('div');
  row.className = 'dt-row';
  row.setAttribute('data-key', key);
  const k = document.createElement('span');
  k.className = 'dt-k';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = 'dt-v';
  v.textContent = value;
  // Copy button stays mounted (hidden when this row has nothing to copy):
  // toggling its existence would churn the DOM the incremental mount is
  // here to avoid. Its target is read at click time so updates that change
  // the value (e.g. a new cwd) copy the right thing.
  const b = document.createElement('button');
  b.className = 'dt-copy';
  b.textContent = T('dt_copy');
  b.hidden = !copyText;
  row.append(k, v, b);
  let currentCopy = copyText || null;
  b.addEventListener('click', (e) => { e.stopPropagation(); if (currentCopy && copy) copy(currentCopy); });
  row._update = (l, val, ct) => {
    if (k.textContent !== l) k.textContent = l;
    if (v.textContent !== val) v.textContent = val;
    currentCopy = ct || null;
    const hide = !ct;
    if (b.hidden !== hide) b.hidden = hide;
  };
  return row;
}

// Mounts/refreshes the card inside `root` (a .dt-card with .dt-title/.dt-body
// — details.html carries the skeleton). ctx = {T, copy, aliases, readAt,
// agentLabel}: T/copy/aliases come from the page; readAt (epoch s, or 0) is
// the read mark in force, sent by main with every push; agentLabel resolves
// the friendly agent name.
function mountDetails(root, s, ctx) {
  const T = ctx.T;
  const title = labelFor(s, ctx.aliases);
  const titleEl = root.querySelector('.dt-title');
  if (titleEl.textContent !== title) titleEl.textContent = title;
  const body = root.querySelector('.dt-body');

  // Full card spec, in order. Existing keyed nodes are updated in place;
  // missing ones are created — syncChildren below reconciles the DOM.
  const specs = [];
  const sec = (key, t) => {
    let el = findKeyed(body, key);
    if (!el) el = dtSec(key, t);
    el._update(t);
    specs.push({ key, el });
  };
  const row = (key, label, value, copyText) => {
    let el = findKeyed(body, key);
    if (el) el._update(label, value, copyText);
    else el = dtRow(key, label, value, copyText, T, ctx.copy);
    specs.push({ key, el });
  };

  // — Session —
  sec('sec:session', T('dt_session'));
  row('agent', T('dt_agent'), ctx.agentLabel ? ctx.agentLabel(s) : agentOf(s));
  row('sid', T('dt_sid'), s.session_id || '—', s.session_id);
  const alias = ctx.aliases[aliasKey(s)];
  if (alias) row('alias', T('dt_alias'), alias);
  if (s.model) row('model', T('dt_model'), s.model);
  // Claude account of the session (#58): label annotated in main from the
  // pid's CLAUDE_CONFIG_DIR environ — tells apart dd-claude profiles with
  // different logins running at once. Remote sessions carry the label of
  // the ORIGIN's account. No resolved label → no row.
  if (s.account) row('account', T('dt_account'), s.account);
  if (s.pid) row('pid', T('dt_pid'), String(s.pid));

  // — Context — (windowid is LOCAL_ONLY: remote sessions don't even have it)
  sec('sec:context', T('dt_context'));
  if (s.cwd) row('cwd', T('dt_cwd'), s.cwd, s.cwd);
  if (s.term_program && s.term_program !== 'terminal') row('term', T('dt_term'), s.term_program);
  if (s.tmux_session) row('tmux', T('dt_tmux'), s.tmux_session);
  row('origin', T('dt_origin'), s.origin || 'local');
  if (s.windowid) row('window', T('dt_window'), String(s.windowid));

  // — Activity —
  sec('sec:activity', T('dt_activity'));
  const age = ageText(Math.floor(Date.now() / 1000), s.last_event_ts);
  row('last_event', T('dt_last_event'), (s.last_event || '—') + (age ? ' · ' + age : ''));
  if (s.last_tool) row('last_tool', T('dt_last_tool'), s.last_tool);
  if (s.notification_type) row('notification', T('dt_notification'), s.notification_type);
  if (ctx.readAt) row('read_until', T('dt_read_until'), new Date(ctx.readAt * 1000).toLocaleTimeString());

  // — Timeline — rolling events[] (50) from the hook; COLLAPSED by default
  // (50 dumped rows would push the fields above the fold). The header shows
  // the count; expanding is explicit. Both header and box are keyed and
  // REUSED, so the expanded/collapsed choice survives every live refresh;
  // only the event rows inside are reconciled when the list itself changes.
  // Event keys must be STABLE under append (CodeRabbit PR #63): keying by the
  // REVERSED array index shifted every key by 1 on each new event, recreating
  // all the rows. Key = event signature + occurrence ordinal counted in
  // CHRONOLOGICAL order: an append keeps every existing key unchanged, and the
  // 50-cap rollover only re-keys AMBIGUOUS duplicates (identical ts+event+tool
  // — indistinguishable anyway).
  const seenSig = new Map();
  const evs = (Array.isArray(s.events) ? s.events : []).map((ev) => {
    const sig = `${(ev && ev.ts) || ''}|${(ev && ev.event) || ''}|${(ev && ev.tool) || ''}`;
    const n = (seenSig.get(sig) || 0) + 1;
    seenSig.set(sig, n);
    return { ev, key: sig + '|#' + n };
  }).reverse();   // newest first for display
  const headKey = 'sec:timeline';
  if (!evs.length) {
    let head = findKeyed(body, headKey);
    if (head && head._kind !== 'sec') head = null;   // was a toggle: rebuild plain
    if (!head) head = dtSec(headKey, T('dt_timeline'));
    head._update(T('dt_timeline'));
    specs.push({ key: headKey, el: head });
    let note = findKeyed(body, 'evs-empty');
    if (!note) {
      note = document.createElement('div');
      note.className = 'dt-v';
      note.setAttribute('data-key', 'evs-empty');
      note._update = (t) => { if (note.textContent !== t) note.textContent = t; };
    }
    note._update(T('dt_no_events'));
    specs.push({ key: 'evs-empty', el: note });
  } else {
    let head = findKeyed(body, headKey);
    if (head && head._kind !== 'toggle') head = null;   // was plain: rebuild toggle
    if (!head) {
      head = document.createElement('div');
      head._kind = 'toggle';
      head.className = 'dt-sec dt-toggle';
      head.setAttribute('data-key', headKey);
      const lbl = document.createElement('span');
      const caret = document.createElement('span');
      caret.className = 'dt-caret';
      head.append(lbl, caret);
      head._update = (t, count) => {
        const txt = `${t} (${count})`;
        if (lbl.textContent !== txt) lbl.textContent = txt;
        const box = findKeyed(body, 'evs');
        caret.textContent = box && !box.hidden ? '▾' : '▸';
      };
      head.addEventListener('click', () => {
        const box = findKeyed(body, 'evs');
        if (!box) return;
        box.hidden = !box.hidden;
        caret.textContent = box.hidden ? '▸' : '▾';
      });
    }
    head._update(T('dt_timeline'), evs.length);
    specs.push({ key: headKey, el: head });

    let box = findKeyed(body, 'evs');
    if (!box) {
      box = document.createElement('div');
      box.className = 'dt-evs';
      box.setAttribute('data-key', 'evs');
      box.hidden = true;                    // collapsed by default, then KEPT
    }
    const evSpecs = evs.map(({ ev, key }) => {
      let el = findKeyed(box, key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'dt-ev';
        el.setAttribute('data-key', key);
        const t = document.createElement('time');
        const x = document.createElement('span');
        el.append(t, x);
        el._update = () => {
          t.textContent = ev.ts ? new Date(ev.ts * 1000).toLocaleTimeString() : '—';
          x.textContent = ev.event + (ev.tool ? ' · ' + ev.tool : '');
        };
        el._update();
      }
      return { key, el };
    });
    syncChildren(box, evSpecs);
    specs.push({ key: 'evs', el: box });
  }

  syncChildren(body, specs);
}

// Session gone from the refresh (died while the window was open): keeps the
// card with a notice — the window must not keep showing the last snapshot as
// if it were still true. Title uses ctx_details (same string as the menu item
// that opens the window).
function mountDetailsGone(root, T) {
  root.querySelector('.dt-title').textContent = T('ctx_details');
  const body = root.querySelector('.dt-body');
  body.replaceChildren();
  const e = document.createElement('div');
  e.className = 'dt-v';
  e.textContent = T('dt_gone');
  body.append(e);
}

// Standalone window bootstrap (details.html). api = the preload's
// window.trafficLight: onDetailsData(cb), closeDetails(), copyText(t),
// getLang(), getAliases(). Main pushes { s, readAt } on every session refresh
// — s === null once the session has ended. Esc and × close (main destroys
// the window).
function initDetailsWindow(api) {
  const card = document.querySelector('.dt-card');
  const closeBtn = document.querySelector('.ts-close');
  let T = makeT('en');
  let aliases = {};
  let mounted = false;        // a details-data push already built the card
  Promise.all([api.getLang(), api.getAliases()])
    .then(([lang, a]) => {
      T = makeT(lang || 'en');
      aliases = a || {};
      // Window-chrome i18n (CodeRabbit PR #63): details.html ships with static
      // lang="en"/title/aria-label; the resolved language localizes them here,
      // with the same keys the overlay uses (ctx_details / btn_close).
      try { document.documentElement.lang = lang || 'en'; } catch {}
      try { document.title = T('ctx_details'); } catch {}
      try { closeBtn.setAttribute('aria-label', T('btn_close')); } catch {}
      // Placeholder only while NO push has arrived: main pushes at
      // did-finish-load, which can beat this invoke round-trip — painting
      // "Session ended" over a just-mounted live card would be a lie.
      if (!mounted) mountDetailsGone(card, T);
    })
    .catch(() => { if (!mounted) mountDetailsGone(card, T); });
  api.onDetailsData(({ s, readAt }) => {
    mounted = true;
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
  closeBtn.addEventListener('click', () => api.closeDetails());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.closeDetails(); }, true);
}

// Browser auto-init. The page CSP (script-src 'self') BLOCKS inline <script>
// — the call can't live in details.html; the module initializes itself when
// the preload bridge exists (same pattern as the other classic scripts). In
// the test vm window.trafficLight doesn't exist: the test calls
// initDetailsWindow(api) explicitly.
if (typeof window !== 'undefined' && window.trafficLight) initDetailsWindow(window.trafficLight);

// Node export (tests) — becomes a global via <script> in the browser.
if (typeof module !== 'undefined') module.exports = {
  basename, labelFor, findKeyed, syncChildren, dtSec, dtRow,
  mountDetails, mountDetailsGone, initDetailsWindow,
};
