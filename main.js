// main.js — processo principal do Electron (ai-traffic-lights).
// Janela overlay translúcida, sempre no topo. Observa o diretório de estado,
// envia sessões ao renderer, auto-redimensiona a altura pelo nº de linhas,
// e persiste largura + posição entre reinícios.

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, Notification, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
const { AGENTS, agentOf } = require('./src/agents');
const hookInstaller = require('./src/hook-installer');

app.commandLine.appendSwitch('no-sandbox'); // sandbox SUID sem root no host

// Diretório de dados neutro (XDG) — o state dir é o contrato entre adapters
// (escritores) e este app (leitor). Ver src/agents.js e hooks/traffic-hook.sh.
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const BASE_DIR = path.join(DATA_HOME, 'ai-traffic-lights');
const STATE_DIR = path.join(BASE_DIR, 'state');
const BOUNDS_FILE = path.join(BASE_DIR, 'window.json'); // {x, y, width}
const ALIASES_FILE = path.join(BASE_DIR, 'aliases.json'); // {cwd: apelido}
const AUTOSTART_FILE = path.join(process.env.HOME, '.config/autostart/ai-traffic-lights.desktop');

// ---- migração da era claude-traffic-light (pré-rename) ----
const OLD_BASE = path.join(process.env.HOME, '.claude-shared/traffic-light');
const OLD_AUTOSTART = path.join(process.env.HOME, '.config/autostart/claude-traffic-light.desktop');
function migrateOldBase() {
  try {
    if (!fs.existsSync(OLD_BASE)) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // window.json / aliases.json: copia se ainda não existirem no novo lugar
    for (const f of ['window.json', 'aliases.json']) {
      const from = path.join(OLD_BASE, f), to = path.join(BASE_DIR, f);
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to); } catch {}
    }
    // state files: move os que não existem no novo dir (hook pode já ter criado)
    const oldState = path.join(OLD_BASE, 'state');
    try {
      for (const f of fs.readdirSync(oldState).filter((x) => x.endsWith('.json'))) {
        const to = path.join(STATE_DIR, f);
        try { if (!fs.existsSync(to)) fs.renameSync(path.join(oldState, f), to); } catch {}
      }
    } catch {}
  } catch {}
}

// Mapa comm(/proc) → agent id, derivado do registro (src/agents.js).
const COMM_TO_AGENT = new Map();
for (const [id, a] of Object.entries(AGENTS)) for (const c of a.comm || []) COMM_TO_AGENT.set(c, id);

const DEFAULT_W = 360;
const HEADER_H = 58; // tem que casar com --header-h do CSS
const MIN_W = 280, MAX_W = 720;
const MIN_H = HEADER_H + 40, MAX_H = 640;

let win;

function readSessions() {
  try {
    const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
        if (s && s.session_id) sessions.push(s);
      } catch { /* parcial/inválido — ignora */ }
    }
    // Acrescenta agentes em terminal sem state file (idle / pré-hook) via /proc.
    for (const { pid, agent } of discoveredTerminalAgents()) {
      if (!sessions.some((s) => s.pid === pid)) {
        sessions.push({ session_id: `proc-${pid}`, pid, agent, cwd: null, term_program: 'terminal', last_event: 'ativo', last_event_ts: 0 });
      }
    }
    // Dedupe por pid: o mesmo processo pode aparecer com 2 session_ids
    // (ex.: job/background roteando 2 contextos). Mantém o mais recente.
    // Modelo do usuário: 1 processo = 1 terminal = 1 linha.
    const byPid = new Map();
    for (const s of sessions) {
      const key = s.pid || s.session_id;
      const prev = byPid.get(key);
      if (!prev || (s.last_event_ts || 0) >= (prev.last_event_ts || 0)) byPid.set(key, s);
    }
    return [...byPid.values()].filter((s) => s.term_program); // esconde headless (sem terminal)
  } catch { return []; }
}

// Acha o transcript de uma sessão pelo session_id (procura em .claude e .zclaude).
function findTranscript(sid) {
  for (const root of [
    path.join(process.env.HOME, '.claude/projects'),
    path.join(process.env.HOME, '.zclaude/projects'),
  ]) {
    try {
      for (const proj of fs.readdirSync(root)) {
        const p = path.join(root, proj, sid + '.jsonl');
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  return null;
}

// Último model usado num transcript.
function lastModel(tp) {
  try {
    if (!tp || !fs.existsSync(tp) || fs.statSync(tp).size > 50_000_000) return null;
    const data = fs.readFileSync(tp, 'utf8');
    let last = null, m;
    const re = /"model":"([^"]+)"/g;
    while ((m = re.exec(data))) last = m[1];
    return last;
  } catch { return null; }
}

// Backfill: sessões com model=null pegam o model do transcript (de cara, no startup).
function backfillModels() {
  let changed = false;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const p = path.join(STATE_DIR, f);
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (s.model) continue;
        const tp = s.transcript_path || findTranscript(s.session_id);
        const m = tp && lastModel(tp);
        if (m) {
          s.transcript_path = tp; s.model = m;
          fs.writeFileSync(p, JSON.stringify(s));
          changed = true;
        }
      } catch {}
    }
  } catch {}
  return changed;
}

// Sonda /proc: descobre agentes rodando em terminal (parent = shell) que AINDA
// NÃO têm state file — sessões idle ou iniciadas antes do adapter. Os nomes de
// processo vêm do registro (src/agents.js). (cwd é ilegível por ptrace_scope →
// essas entram com label fallback "<agente> · PID".)
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);
function discoverAgentProcs() {
  const found = [];
  try {
    for (const ent of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      try {
        const comm = fs.readFileSync(`/proc/${ent}/comm`, 'utf8').trim();
        const agent = COMM_TO_AGENT.get(comm);
        if (!agent) continue;
        const status = fs.readFileSync(`/proc/${ent}/status`, 'utf8');
        const m = status.match(/^PPid:\s+(\d+)/m);
        if (!m) continue;
        let pcomm = '';
        try { pcomm = fs.readFileSync(`/proc/${m[1]}/comm`, 'utf8').trim(); } catch {}
        if (SHELLS.has(pcomm)) found.push({ pid: parseInt(ent, 10), agent });
      } catch {}
    }
  } catch {}
  return found;
}
let _disc = null, _discAt = 0;
function discoveredTerminalAgents() {
  if (_disc && Date.now() - _discAt < 4000) return _disc; // cache 4s
  _disc = discoverAgentProcs();
  _discAt = Date.now();
  return _disc;
}

// ---- click-to-focus: ativa a janela (e a ABA, quando possível) da sessão ----
// Estratégia em camadas (X11):
//  1) windowid do state file — capturado pelo hook via `xdotool getactivewindow`
//     no último UserPromptSubmit/SessionStart. Único método que desambigua
//     terminais single-process multi-janela (Warp, Tilix, gnome-terminal) e
//     sessões dentro de zellij/tmux (árvore de processos descolada do terminal).
//  2) fallback: ancestralidade de processos → 1ª janela do PID do emulador.
//     Acha o app certo, mas pode errar a janela se o processo tiver várias.
//  3) focus_url — URI nativa de foco do terminal (Warp: warp://session/<uuid>).
//     Abas são invisíveis pro X11; só o próprio terminal alcança a aba certa.
//     Roda por último: o raise da janela (1/2) já aconteceu; a URI troca a aba
//     (no Warp ela também faz raise — camadas se reforçam, nunca conflitam).
const FOCUS_URL_SCHEMES = ['warp://']; // allowlist — só abrimos URI que conhecemos
function focusSession(target) {
  const pid = target && target.pid;
  const windowid = target && target.windowid;
  const focusUrl = target && target.focus_url;
  let list = '';
  try { list = execFileSync('wmctrl', ['-l', '-p'], { encoding: 'utf8', timeout: 2000 }); } catch {}
  const wins = [];
  for (const line of list.split('\n')) {
    const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s/);
    if (m) wins.push({ id: m[1], idNum: parseInt(m[1], 16), pid: parseInt(m[2], 10) });
  }
  const activate = (id) => { try { execFileSync('wmctrl', ['-i', '-a', id], { timeout: 2000 }); } catch {} };

  // 1) janela exata (valida contra a lista — id pode estar obsoleto)
  let raised = false;
  if (windowid) {
    const str = String(windowid);
    const wid = parseInt(str, str.startsWith('0x') ? 16 : 10);
    const hit = wins.find((w) => w.idNum === wid);
    if (hit) { activate(hit.id); raised = true; }
  }

  // 2) ancestralidade de processos
  if (!raised && pid) {
    const ancestors = new Set();
    let p = pid;
    for (let i = 0; i < 25 && p > 1; i++) {
      ancestors.add(p);
      try {
        const m = fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
        if (!m) break;
        p = parseInt(m[1], 10);
      } catch { break; }
    }
    const hit = wins.find((w) => ancestors.has(w.pid));
    if (hit) activate(hit.id);
  }

  // 3) aba certa dentro da janela (Warp) — via handler do scheme
  if (focusUrl && FOCUS_URL_SCHEMES.some((s) => String(focusUrl).startsWith(s))) {
    try { execFileSync('xdg-open', [String(focusUrl)], { timeout: 2000 }); } catch {}
  }
}

// ---- aliases (apelido manual por cwd) ----
function loadAliases() {
  try { return JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveAlias(cwd, alias) {
  const a = loadAliases();
  if (alias && alias.trim()) a[cwd] = alias.trim();
  else delete a[cwd];
  try { fs.writeFileSync(ALIASES_FILE, JSON.stringify(a)); } catch {}
}

// ---- autostart ----
function autostartEnabled() {
  try { return fs.existsSync(AUTOSTART_FILE); } catch { return false; }
}
function setAutostart(on) {
  try {
    try { fs.unlinkSync(OLD_AUTOSTART); } catch {} // limpa o .desktop da era pré-rename
    if (on) {
      const desktop = `[Desktop Entry]\nType=Application\nName=AI Traffic Lights\nExec=${process.execPath} ${__dirname} --no-sandbox\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, desktop);
    } else {
      try { fs.unlinkSync(AUTOSTART_FILE); } catch {}
    }
  } catch {}
}

function sendSessions() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('sessions', readSessions());
}

// Limpeza: remove state files cujo PID morreu (sem SessionEnd — ex.: crash/kill
// do terminal). process.kill(pid,0) só testa existência (não afetado por ptrace).
// Também varre .tmp órfãos (escrita atômica abortada) com mais de 60s.
function reapDead() {
  let changed = false;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.tmp'))) {
      try {
        const p = path.join(STATE_DIR, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 60_000) fs.unlinkSync(p);
      } catch {}
    }
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      const p = path.join(STATE_DIR, f);
      let s = null;
      try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      if (!s) {
        // vazio/corrompido (race de escrita): não tem pid pro reap normal.
        // Sessão viva regrava o arquivo no próximo evento (hook usa try/fromjson);
        // se está parado há >10min, é lixo de sessão morta — remove.
        try { if (Date.now() - fs.statSync(p).mtimeMs > 600_000) { fs.unlinkSync(p); changed = true; } } catch {}
        continue;
      }
      if (!s.pid) continue;
      try { process.kill(s.pid, 0); }         // vivo? (não lança)
      catch { try { fs.unlinkSync(p); changed = true; } catch {} }
    }
  } catch {}
  if (changed) sendSessions();
}

// ---- persistência de bounds (só width + posição; altura é auto) ----
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')); } catch { return null; }
}
let saveTimer = null;
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const [x, y] = win.getPosition();
      const [width] = win.getSize();
      fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ x, y, width }));
    } catch { /* ignore */ }
  }, 300);
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const scrW = display.workAreaSize.width;
  const bounds = loadBounds();
  const width = (bounds && bounds.width) || DEFAULT_W;
  const x = (bounds && typeof bounds.x === 'number') ? bounds.x : scrW - DEFAULT_W - 12;
  const y = (bounds && typeof bounds.y === 'number') ? bounds.y : 12;

  win = new BrowserWindow({
    width, height: HEADER_H + 120, // placeholder; renderer corrige via auto-height
    x, y,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    type: 'toolbar',        // X11: _NET_WM_WINDOW_TYPE_TOOLBAR → fora do alt-tab/dock
    maximizable: false,     // (não implementado no Linux; vale nas demais plataformas)
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Linux/Mutter ignora `maximizable` → reverte na hora qualquer maximize
  // (Super+↑, drag no topo da tela, tiling). Overlay nunca vira tela cheia.
  win.on('maximize', () => { try { win.unmaximize(); } catch {} });
  win.loadFile(path.join(__dirname, 'src/index.html'));
  win.webContents.on('did-finish-load', sendSessions);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Log do renderer só com ATL_DEBUG=1 (debug off em produção).
  if (process.env.ATL_DEBUG) {
    win.webContents.on('console-message', (_e, level, message) =>
      fs.appendFileSync('/tmp/atl-renderer.log', `[${level}] ${message}\n`));
  }
}

// Mostrar/ocultar centralizado. No show, re-afirma skipTaskbar — alguns WMs
// resetam o hint no ciclo hide/show (bug conhecido de Electron/X11).
function toggleWin() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else { win.show(); try { win.setSkipTaskbar(true); } catch {} }
}

// ---- tray (bandeja) ----
// Cópia estável do hook + registro no settings.json — caminho único que
// funciona do fonte E empacotado (AppImage monta em path efêmero).
function installHookFromApp() {
  try {
    const dest = hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR);
    const r = hookInstaller.install(`bash ${dest}`);
    notifyUser(r.wrote
      ? `Hook instalado (${r.added} eventos, ${r.updated} atualizados).`
      : 'Hook já instalado e atualizado.');
  } catch (e) { notifyUser(`Falha ao instalar hook: ${e.message}`); }
}
function removeHookFromApp() {
  try {
    const r = hookInstaller.remove();
    notifyUser(r.removed ? `Hook removido (${r.removed} entradas).` : 'Nada instalado.');
  } catch (e) { notifyUser(`Falha ao remover hook: ${e.message}`); }
}
function notifyUser(body) {
  try { new Notification({ title: 'AI Traffic Lights', body, silent: true }).show(); } catch {}
}

let tray = null;
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/tray-icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('AI Traffic Lights');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Mostrar/Ocultar', accelerator: 'Ctrl+Alt+H', click: toggleWin },
    { type: 'checkbox', label: 'Iniciar com o sistema', checked: autostartEnabled(),
      click: (it) => { setAutostart(it.checked); } },
    { type: 'separator' },
    { label: 'Instalar/atualizar hook (Claude Code)', click: installHookFromApp },
    { label: 'Remover hook', click: removeHookFromApp },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', toggleWin);
}

// ---- IPC ----
ipcMain.on('request-sessions', sendSessions);

ipcMain.on('set-expanded', (_e, expanded) => {
  if (!win || win.isDestroyed()) return;
  // expandido = altura auto (renderer pede); recolhido = só header
  if (!expanded) win.setSize(win.getSize()[0], HEADER_H, false);
});

// Altura automática pelo conteúdo (n linhas). Largura e posição preservadas.
ipcMain.on('auto-height', (_e, h) => {
  if (!win || win.isDestroyed()) return;
  const clamped = Math.max(MIN_H, Math.min(Math.round(h), MAX_H));
  const [w] = win.getSize();
  win.setSize(w, clamped, false);
});

// Gripper: só largura (altura é auto). Persiste ao soltar.
let resizeStart = null;
ipcMain.on('resize-start', () => {
  if (!win || win.isDestroyed()) return;
  resizeStart = win.getSize();
});
ipcMain.on('resize-move', (_e, { dw }) => {
  if (!win || win.isDestroyed() || !resizeStart) return;
  const w = Math.max(MIN_W, Math.min(resizeStart[0] + dw, MAX_W));
  win.setSize(Math.round(w), resizeStart[1], false);
});

ipcMain.on('quit', () => app.quit());

// Click-to-focus: ativa o terminal da sessão ({pid, windowid}).
ipcMain.on('focus', (_e, target) => focusSession(target));

// Aliases (apelido por cwd).
ipcMain.handle('get-aliases', () => loadAliases());
ipcMain.on('set-alias', (_e, { cwd, alias }) => { saveAlias(cwd, alias); sendSessions(); });

// Notificação no vermelho.
ipcMain.on('notify', (_e, { title, body }) => {
  try { new Notification({ title, body, silent: true }).show(); } catch {}
});

// Tray: mostrar/ocultar, autostart, sair.
ipcMain.on('toggle-visibility', toggleWin);

app.whenReady().then(() => {
  migrateOldBase();                              // dados da era claude-traffic-light
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  // mantém a cópia estável do hook em dia (o settings.json aponta pra ela)
  try { hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR); } catch {}
  createWindow();
  createTray();
  // Atalho global de exibir/ocultar: Ctrl+Alt+H (primário) + legado
  // Ctrl+Shift+Alt+L. Rede de segurança contra "× esconde e o tray some".
  // (Registro pode falhar se o desktop já usa a combinação — o tray cobre.)
  for (const acc of ['Control+Alt+H', 'CommandOrControl+Shift+Alt+L']) {
    try { globalShortcut.register(acc, toggleWin); } catch {}
  }
  if (backfillModels()) sendSessions(); // preenche model das sessões existentes de cara
  chokidar
    .watch(STATE_DIR, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 } })
    .on('all', () => sendSessions());
  reapDead();
  setInterval(() => { _discAt = 0; reapDead(); sendSessions(); }, 5000); // descobre novos + limpa mortos
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
