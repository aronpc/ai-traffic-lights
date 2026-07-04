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
const focus = require('./src/focus');
const sessions = require('./src/sessions');

app.commandLine.appendSwitch('no-sandbox'); // sandbox SUID sem root no host

// Instância única: relançar o app não duplica o overlay — TOGGLA o existente
// e sai. Previne overlays duplicados (autostart + lançamento manual) e dá um
// caminho de atalho no Wayland, onde X grabs (globalShortcut) não disparam
// com um app Wayland nativo em foco: vincule um atalho do GNOME ao comando
// do app e cada acionamento mostra/oculta.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => toggleWin());

// Sessão gráfica: no Wayland, wmctrl/xdotool só enxergam janelas XWayland —
// o foco por janela degrada e a URI nativa do terminal vira o caminho titular.
const IS_WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland' ||
  (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11');

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

// Mapas de detecção → agent id, derivados do registro (src/agents.js).
// comm: nome do processo. argv: basename do script (p/ CLIs Node cujo comm
// é "node" — ex.: gemini — identifica pelo caminho em /proc/<pid>/cmdline).
const COMM_TO_AGENT = new Map();
const ARGV_TO_AGENT = new Map();
for (const [id, a] of Object.entries(AGENTS)) {
  for (const c of a.comm || []) COMM_TO_AGENT.set(c, id);
  for (const s of a.argv || []) ARGV_TO_AGENT.set(s, id);
}

const DEFAULT_W = 360;
const HEADER_H = 58; // tem que casar com --header-h do CSS
const MIN_W = 280, MAX_W = 720;
const MIN_H = HEADER_H + 40, MAX_H = 640;

let win;

function readSessions() {
  try {
    const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
    const stateFileSessions = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
        if (s && s.session_id) stateFileSessions.push(s);
      } catch { /* parcial/inválido — ignora */ }
    }
    // Merge + dedup (lógica pura em src/sessions.js). Sem filtro por
    // term_program: Tilix não exporta TERM_PROGRAM e sumia do overlay.
    // O gate de "interativo" é o parent=shell (sonda /proc) e o próprio
    // state file (o hook só dispara em sessão interativa).
    return sessions.mergeSessions(stateFileSessions, discoveredTerminalAgents());
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
        let agent = COMM_TO_AGENT.get(comm);
        // CLIs Node (comm="node"): identifica pelo basename do script no argv
        if (!agent && comm === 'node' && ARGV_TO_AGENT.size) {
          try {
            const argv = fs.readFileSync(`/proc/${ent}/cmdline`, 'utf8').split('\0');
            agent = ARGV_TO_AGENT.get(path.basename(argv[1] || ''));
          } catch {}
        }
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
// Duas responsabilidades separadas (a decisão pura vive em src/focus.js):
//  • JANELA (X11/wmctrl): pickWindow() valida o windowid gravado contra a
//    árvore de processos da sessão — um id obsoleto/reciclado não foca mais a
//    janela errada (issue #1, H2); sem id válido, 1ª janela do processo.
//  • ABA (canal nativo do terminal, invisível pro X11): tabChannel() escolhe
//    Warp (`xdg-open warp://session/<uuid>`) ou Tilix (`gdbus activate-terminal
//    <TILIX_ID>`). É a única forma de alcançar a aba/pane certa.
// Ordem: no X11, raise a janela e então troca a aba. No Wayland, a aba primeiro
// (wmctrl só enxerga XWayland) e o raise vira tentativa-bônus.
function ancestorPidsOf(pid) {
  const set = new Set();
  let p = pid;
  for (let i = 0; i < 25 && p > 1; i++) {
    set.add(p);
    try {
      const m = fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
      if (!m) break;
      p = parseInt(m[1], 10);
    } catch { break; }
  }
  return set;
}

function raiseWindow(windowid, pid) {
  if (!pid) return;
  let list = '';
  try { list = execFileSync('wmctrl', ['-l', '-p'], { encoding: 'utf8', timeout: 2000 }); } catch { return; }
  const wins = [];
  for (const line of list.split('\n')) {
    const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s/);
    if (m) wins.push({ id: m[1], idNum: parseInt(m[1], 16), pid: parseInt(m[2], 10) });
  }
  const id = focus.pickWindow(windowid, wins, ancestorPidsOf(pid));
  if (id) { try { execFileSync('wmctrl', ['-i', '-a', id], { timeout: 2000 }); } catch {} }
}

function focusTab(state) {
  const ch = focus.tabChannel(state);
  if (!ch) return;
  try {
    if (ch.kind === 'warp') {
      execFileSync('xdg-open', [ch.value], { timeout: 2000 });
    } else if (ch.kind === 'tilix') {
      execFileSync('gdbus', ['call', '--session', '--dest', 'com.gexperts.Tilix',
        '--object-path', '/com/gexperts/Tilix', '--method', 'org.gtk.Actions.Activate',
        'activate-terminal', `[<'${ch.value}'>]`, '{}'], { timeout: 2000 });
    }
  } catch {}
}

// Enriquece o alvo com os hints de foco lidos AO VIVO do /proc/<pid>/environ.
// O state file guarda um snapshot capturado no prompt; o environ é a fonte
// viva — cobre sessões cujo evento veio antes do hook atual e as detectadas
// só via /proc (sem focus_url/tilix_id no state). O state tem precedência.
function enrichTarget(target) {
  if (!target || !target.pid || (target.focus_url && target.tilix_id)) return target;
  try {
    const hints = focus.parseEnviron(fs.readFileSync(`/proc/${target.pid}/environ`, 'utf8'));
    return {
      ...target,
      focus_url: target.focus_url || hints.focus_url,
      tilix_id: target.tilix_id || hints.tilix_id,
    };
  } catch { return target; }
}

function focusSession(target) {
  if (!target) return;
  const t = enrichTarget(target);
  const raise = () => raiseWindow(t.windowid, t.pid);
  const tab = () => focusTab(t);
  if (IS_WAYLAND) { tab(); raise(); }
  else { raise(); tab(); }
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

// Aplica _NET_WM_STATE_SKIP_TASKBAR + SKIP_PAGER via wmctrl no X11 id da
// janela. No Wayland wmctrl é inócuo (silencioso). Idempotente.
function applySkip() {
  if (!win || win.isDestroyed() || IS_WAYLAND) return;
  try {
    const buf = win.getNativeWindowHandle(); // X11: XID little-endian
    const xid = '0x' + buf.readUInt32LE(0).toString(16).padStart(8, '0');
    execFileSync('wmctrl', ['-i', '-r', xid, '-b', 'add,skip_taskbar,skip_pager'], { timeout: 1500 });
  } catch {}
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
    skipTaskbar: true,       // fora da barra de tarefas e do alt-tab (SKIP_TASKBAR/PAGER)
    maximizable: false,      // (não implementado no Linux; vale nas demais plataformas)
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
  // skipTaskbar FORÇADO via wmctrl: no Mutter, com frameless+transparent+
  // alwaysOnTop, nem a option `skipTaskbar` nem setSkipTaskbar() geram o
  // hint X11 _NET_WM_STATE_SKIP_TASKBAR/PAGER de forma confiável (ele é
  // rebuildado e descartado a cada chamada de always-on-top). O `type:
  // 'toolbar'` fazia o hint na marra — mas removia _NET_WM_ACTION_MOVE,
  // travando a janela. wmctrl aplica o skip SEM tocar nas allowed actions.
  // O IS_LINUX/X11 guarda isso: no Wayland nativo wmctrl é inócuo.
  win.once('ready-to-show', () => { try { win.setSkipTaskbar(true); } catch {} applySkip(); });
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
    const parts = [];
    for (const id of Object.keys(hookInstaller.TARGETS)) {
      const t = hookInstaller.TARGETS[id];
      if (!hookInstaller.available(id)) continue;      // agente não presente na máquina
      const r = hookInstaller.install(id, dest);
      parts.push(`${t.label}: ${r.wrote ? `instalado (${r.added}+${r.updated})` : 'ok'}`);
    }
    if (hookInstaller.opencodeAvailable()) {
      hookInstaller.installOpencode(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
      parts.push('OpenCode: plugin ok');
    }
    notifyUser(parts.length ? parts.join(' · ') : 'Nenhum agente suportado encontrado.');
  } catch (e) { notifyUser(`Falha ao instalar hook: ${e.message}`); }
}
function removeHookFromApp() {
  try {
    const parts = [];
    for (const id of Object.keys(hookInstaller.TARGETS)) {
      const t = hookInstaller.TARGETS[id];
      const r = hookInstaller.remove(id);
      if (r.removed) parts.push(`${t.label}: ${r.removed} removidas`);
    }
    if (hookInstaller.removeOpencode().removed) parts.push('OpenCode: plugin removido');
    notifyUser(parts.length ? parts.join(' · ') : 'Nada instalado.');
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
    { label: 'Instalar/atualizar hooks (Claude, Gemini)', click: installHookFromApp },
    { label: 'Remover hooks', click: removeHookFromApp },
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
  // idem pro plugin do OpenCode (só se o usuário já o instalou)
  hookInstaller.syncOpencodeIfInstalled(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
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
  setInterval(() => { _discAt = 0; reapDead(); sendSessions(); saveBounds(); }, 5000); // descobre novos + limpa mortos + captura posição (drag externo p/ ex.)
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
