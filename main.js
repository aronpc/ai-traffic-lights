// main.js — processo principal do Electron (ai-traffic-lights).
// Janela overlay translúcida, sempre no topo. Observa o diretório de estado,
// envia sessões ao renderer, auto-redimensiona a altura pelo nº de linhas,
// e persiste largura + posição entre reinícios.

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, Notification, nativeImage, globalShortcut, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
const { AGENTS, agentOf } = require('./src/agents');
const hookInstaller = require('./src/hook-installer');
const kiroAdapter   = require('./adapters/kiro/ai-traffic-lights');
const focus = require('./src/focus');
const sessions = require('./src/sessions');
const collect = require('./src/collect');
const net = require('./src/net');
const transcript = require('./src/transcript');
const settingsLib = require('./src/settings');
const i18n = require('./src/i18n');
const launcher = require('./src/launcher');
const usage = require('./src/usage');
const claudePaths = require('./src/claude-config');
const readMarksLib = require('./src/read-marks');
const { sessionKey, rewriteKeyOrigin, isLocalSession } = require('./src/identity');
const { spawn } = require('child_process');
const { desktopEscape, shellQuote, boundsOnScreen } = require('./src/validate');

// Flags de sandbox/shared-memory (--no-sandbox --disable-dev-shm-usage) vão na
// LINHA DE COMANDO: build.linux.executableArgs (packaged) e scripts.start (dev).
// Precisam chegar ao Chromium ANTES de ele inicializar o sandbox/shm — aqui no
// main.js é tarde demais (appendSwitch não funciona p/ esses switches), e a
// janela ficava transparente (sem compositing). Não usar appendSwitch aqui.

// Versão do app (do package.json — app.getVersion lê direto, funciona no asar)
// e URL pública do repo (rodapé das Preferências + tooltip do tray).
const APP_VERSION = app.getVersion();
const REPO_URL = 'https://github.com/aronpc/ai-traffic-lights';
// Feature de sync (P2P) é beta: só em build pre-release (0.7.4-beta.N, lida de
// app.getVersion). Na estável/fonte (0.7.3) a aba Sincronização some e nada de
// sync é gravado ou sobe.
const SYNC_AVAILABLE = settingsLib.isPrerelease(APP_VERSION);

// Instância única: relançar o app não duplica o overlay — TOGGLA o existente
// e sai. Previne overlays duplicados (autostart + lançamento manual) e dá um
// caminho de atalho no Wayland, onde X grabs (globalShortcut) não disparam
// com um app Wayland nativo em foco: vincule um atalho do GNOME ao comando
// do app e cada acionamento mostra/oculta.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => toggleWin());

// Sessão gráfica: no Wayland, wmctrl/xdotool só enxergam janelas XWayland —
// o foco por janela degrada e a URI nativa do terminal vira o caminho titular.
// Em XWayland forçado (--ozone-platform=x11 via executableArgs/start), o app é
// X11: wmctrl/xdotool enxergam as janelas e alwaysOnTop funciona (Wayland
// nativo ignora 'above'). Só tratamos como Wayland nativo (onde wmctrl falha e
// o foco por janela degrada) quando a flag NÃO está presente E a sessão é wayland.
const IS_WAYLAND = !process.argv.includes('--ozone-platform=x11') &&
  (process.env.XDG_SESSION_TYPE === 'wayland' ||
    (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11'));

// Diretório de dados neutro (XDG) — o state dir é o contrato entre adapters
// (escritores) e este app (leitor). Ver src/agents.js e hooks/traffic-hook.sh.
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const BASE_DIR = path.join(DATA_HOME, 'ai-traffic-lights');
const STATE_DIR = path.join(BASE_DIR, 'state');
const BOUNDS_FILE = path.join(BASE_DIR, 'window.json'); // {x, y, width}
const ALIASES_FILE = path.join(BASE_DIR, 'aliases.json'); // {sessionKey: apelido}
const ACCOUNT_LABELS_FILE = path.join(BASE_DIR, 'account-labels.json'); // {accountUuid|dir: apelido da CONTA Claude (#58)
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json'); // {idleThresholdSec, escalateIdle, shortcut}
const USAGE_FILE = path.join(BASE_DIR, 'usage.json'); // último uso conhecido (sobrevive a reinício; mostrado stale até refrescar)
const CLAUDE_COOLDOWN_FILE = path.join(BASE_DIR, 'claude-cooldown.json'); // {until:<ms>} — cooldown do 429 da API de uso (SÓ o timestamp, nunca o token)
const SETTINGS_BOUNDS_FILE = path.join(BASE_DIR, 'settings-window.json'); // {x, y, width, height}
const TERM_BOUNDS_FILE = path.join(BASE_DIR, 'term-window.json'); // {x, y, width, height} da janela Terminal
const READ_MARKS_FILE = path.join(BASE_DIR, 'read-marks.json'); // {sessionKey: readAt} — marca de lido persistente (#56)
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

// Mapas de detecção (COMM_TO_AGENT/ARGV_TO_AGENT/SHELLS) e a sonda /proc vivem
// em src/collect.js (core Electron-free, reusado pelo futuro agent.js headless).
// AGENTS ainda é usado aqui p/ UI/launcher/tray.

const DEFAULT_W = 360;
const HEADER_H = 58; // tem que casar com --header-h do CSS
const MIN_W = 348, MAX_W = 720; // 348: header com 5 botões (lista+footer+prefs+expand+fechar) sem cortar o ×
const MIN_H = HEADER_H + 40;

let win;

// Teto de altura do overlay = 90% da work area da TELA onde a janela está
// (não um fixo): rolar a lista é último caso, só quando a sessões não cabem
// nem em quase a tela inteira. Recalculado a cada auto-height — arrastar o
// overlay pra um monitor menor corrige o teto no próximo render (2s).
// Era MAX_H = 640 fixo: em 1080p a lista rolava com ~16 linhas usando só 60%
// da tela. O 90% (e não 100%) deixa respiro pro overlay nunca encostar no
// rodapé da tela nem cobrir o dock/notificações.
function maxOverlayH() {
  if (!win || win.isDestroyed()) return 640;
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  return Math.max(MIN_H, Math.round(wa.height * 0.9));
}

// Coleta de sessões: locais (collect) + remotas (peers, já com `origin` setada
// pelo pollPeers). Wrapper preserva os call sites (sendSessions, timers, ipc).
// Sessões remotas entram no MESMO pipeline — sessionKey (namespaced por origin,
// em identity.js) as separa das locais, sem colisão de pid entre máquinas.
function readSessions() {
  const local = collect.readSessions();
  const all = remoteSessions.size ? local.concat(Array.from(remoteSessions.values()).flat()) : local;
  return annotateClaudeAccounts(all);
}

// Conta Claude de cada sessão (modal de detalhes): resolve o rótulo a partir
// do CLAUDE_CONFIG_DIR do environ do pid — mesma descoberta do
// claudeAccountsFromSessions (#58), mas por sessão. A lógica vive em
// src/annotate.js (testável): cache só do dir por pid (environ não muda na
// vida do processo → uma leitura de /proc por sessão NOVA), rótulo recomputado
// a cada ciclo (rename no tile propaga) e hit guardado por session_id (pid
// reusado por outro processo re-lê o environ). Remota (com origin) já chega
// anotada pelo peer: o rótulo é inofensivo (apelido/org/local-part — nunca
// email completo/uuid) e NÃO é LOCAL_ONLY, viaja no payload de /sessions.
// Anotação em memória: nada disso é gravado no state file.
const annotateClaudeAccounts = require('./src/annotate').makeAnnotator({
  getEnviron: getProcessEnviron,
  parseEnviron: usage.parseEnviron,
  readClaudeConfig: (dir) => usage.readClaudeConfig({ home: app.getPath('home'), dir }), // cache mtime
  accountLabel: usage.accountLabel,
  apiProviderFromSettings: usage.apiProviderFromSettings,
  agentOf,
  labelsFile: ACCOUNT_LABELS_FILE,
  fs,
});

// ---- click-to-focus: ativa a janela (e a ABA, quando possível) da sessão ----
// Duas responsabilidades separadas (a decisão pura vive em src/focus.js):
//  • JANELA (X11/wmctrl): pickWindow() valida o windowid gravado contra a
//    árvore de processos da sessão — um id obsoleto/reciclado não foca mais a
//    janela errada (issue #1, H2); sem id válido, 1ª janela do processo.
//  • ABA (canal nativo do terminal, invisível pro X11): tabChannel() escolhe
//    Warp (`xdg-open warp://session/<uuid>`) ou Tilix (`gdbus activate-terminal
//    <TILIX_ID>`). É a única forma de alcançar a aba/pane certa.
// focus (raiseWindow/focusTab/focusTmuxPane/enrichTarget/focusSession + ancestorPidsOf): extraído para src/ipc/focus.js (REF passo 4)
function parseMacOSEnviron(content) {
  if (!content) return '';
  const regex = /(?<=\s|^)([A-Za-z0-9_]+)=/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push({
      key: match[1],
      index: match.index,
      valueStart: match.index + match[0].length
    });
  }
  const envVars = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].valueStart;
    const end = (i + 1 < matches.length) ? matches[i + 1].index : content.length;
    const val = content.slice(start, end).trim();
    envVars.push(`${matches[i].key}=${val}`);
  }
  return envVars.join('\0');
}


function getProcessEnviron(pid) {
  if (!pid) return '';
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ps', ['-p', pid, '-E'], { encoding: 'utf8', timeout: 1000 });
      const lines = output.split('\n');
      if (lines.length < 2) return '';
      const content = lines.slice(1).join(' ');
      return parseMacOSEnviron(content);
    } catch {
      return '';
    }
  } else {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      return '';
    }
  }
}

// aliases (loadAliases/saveAlias + handlers get-aliases/set-alias): extraídos
// para src/ipc/aliases.js (REF passo 7). Registrados no boot via setupAliasesIpc.

// ---- idioma (i18n) ----
// Prioridade: escolha manual nas Preferências (settings.lang ≠ 'auto') >
// locale do sistema (app.getLocale, só vale após o ready). Distribuído aos
// renderers via IPC get-lang; default en até o ready — nada visível antes.
let LANG = 'en';
let T = i18n.makeT(LANG);
function applyLang() {
  const pref = settingsCfg && settingsCfg.lang;
  LANG = (pref === 'en' || pref === 'pt') ? pref : i18n.pickLang(app.getLocale());
  T = i18n.makeT(LANG);
}

// ---- settings (threshold de idle + atalho global) ----
let settingsCfg = settingsLib.mergeWithDefaults(null);   // sempre válido
function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return settingsLib.mergeWithDefaults(raw);
}
function persistSettings(cfg) {
  // Merge sobre o estado ATUAL, não sobre os defaults: as Preferências mandam
  // um cfg PARCIAL (só os campos delas). Sem espalhar settingsCfg antes, cada
  // save resetaria showUsage/collapsed/launchers pro default — apaga launcher
  // custom e pisca o rodapé. Crucial pro live-apply (grava a cada mudança) e
  // conserta o wipe latente que o "Salvar" batch já tinha.
  settingsCfg = settingsLib.mergeWithDefaults({ ...settingsCfg, ...cfg });
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCfg, null, 2)); } catch {}
  return settingsCfg;
}

// Registra o atalho configurado de mostrar/ocultar. Idempotente: limpa os
// anteriores antes. Mantém o legado CommandOrControl+Shift+Alt+L como rede
// de segurança (se o usuário muda o primário e esquece, ainda há um caminho).
function applyShortcut() {
  try { globalShortcut.unregisterAll(); } catch {}
  for (const acc of [settingsCfg.shortcut, 'CommandOrControl+Shift+Alt+L']) {
    if (acc && settingsLib.isValidShortcut(acc)) {
      try { globalShortcut.register(acc, toggleWin); } catch {}
    }
  }
}

// ---- Quick Launcher: detecta CLIs instalados e sobe um agente num terminal ----
// Detecção por PATH scan (fork-free: só fs.access nos dirs do PATH). O Electron
// roda fora do shell interativo, então não vê aliases — acha o binário real.
// CLIs só-alias (sem bin no PATH) entram via override settings.launchers[id].
// launcher (detectLaunchers/availableTerminals/launchAgent): extraído para src/ipc/launcher.js (REF passo 5)
function scanPathBin(bin) {
  const path = process.env.PATH || '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = path_join(dir, bin);
    try { if (fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true)) return p; } catch {}
  }
  return null;
}
function path_join(dir, bin) { // path.join local (sem sobrescrever o require)
  return dir.replace(/\/+$/, '') + '/' + bin;
}

// detectLaunchers + o cache (_launchers/_launchersAt): extraídos para
// src/ipc/launcher.js (REF passo 5), junto com availableTerminals.

// Cwd mais recente entre as sessões (pra onde o "+ agente" abre por padrão).
function lastSessionCwd() {
  let best = null, bestTs = 0;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
        if (s && s.cwd && (s.last_event_ts || 0) >= bestTs) { bestTs = s.last_event_ts || 0; best = s.cwd; }
      } catch {}
    }
  } catch {}
  return best;
}

// Sobe o agente num terminal no cwd dado. Detached + unref: o overlay não é pai
// do processo — a sessão entra no semáforo pelo caminho normal (hooks → state).

// ---- attach remoto (tmux): abre um terminal LOCAL attachado a uma sessão tmux
// (local direto, ou remota via SSH/Tailscale). Vivo e compartilhado (multi-
// cliente): sem --resume, sem derrubar o terminal da outra máquina. Sanitiza
// nome+host (vêm de config/peer — anti-injeção de shell no comando remoto).
// Warp: launch-config YAML + warp://launch. O scheme warp:// costuma estar
// registrado (dev.warp.Warp.desktop) MESMO quando o binário `warp` não está no
// PATH — então xdg-open abre o app e roda o comando do config.
// Nome da aba do Terminal. Ordem: alias > label da linha (o renderer manda o
// MESMO labelFor que desenha na lista) > basename do cwd > 'tmux: <sessão>'.
// O fallback pro nome tmux é último recurso: é id interno do multiplexador
// ("41"), não diz nada pro usuário e não batia com o nome da lista.
// Sessão remota leva o prefixo da máquina de origem.
function termTabTitle({ alias, label, cwd, tmux_session, origin, isLocal }) {
  const base = alias
    || label
    || (cwd ? String(cwd).replace(/\/+$/, '').split('/').pop() : '')
    || ('tmux: ' + (tmux_session || 'shell'));
  return (isLocal ? '' : (origin || '') + ' · ') + base;
}

// Religa uma aba cuja conexão morreu (pty encerrado / WS caído). Reusa o que a
// sessão já guarda — não depende de nada vir da linha clicada, então funciona
// mesmo quando o revive parte de um clique na aba, não na lista. Limpa a tela
// antes: o buffer velho é de uma conexão que não existe mais.
function reviveTermSession(tabId, s) {
  sendTerm('pty-out', { tabId, data: '\x1b[2J\x1b[H\x1b[90m[reconectando…]\x1b[0m\r\n' });
  if (s.kind === 'local') {
    spawnPtyLocal(tabId, ['tmux', 'attach', '-t', s.tmux_session], s.cwd);
    return;
  }
  const host = originToHost.get(s.origin) || '';
  const cfg = (settingsCfg && settingsCfg.sync) || {};
  if (!host || !cfg.token) {
    sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem host/token para ' + (s.origin || '?') + '\x1b[0m\r\n' });
    return;
  }
  openRemotePty(tabId, { host, port: cfg.port, token: cfg.token, tmux_session: s.tmux_session });
}

function attachRemote({ origin, tmux_session, cwd, alias, key, label }) {
  if (!tmux_session) { notifyUser(T('ntf_attach_no_tmux')); return; }
  const isLocal = !origin || origin === 'local';
  const dupKey = (isLocal ? 'local' : origin) + '|' + tmux_session;
  // dedupe: aba dessa sessão já existe → foca. Mas se a conexão MORREU (peer
  // reiniciou, wifi caiu, sync desligado do outro lado), a aba fica órfã no Map
  // com ws/proc null: focar sem religar deixava a aba VAZIA pra sempre, sem
  // nenhuma forma de recuperar além de fechá-la na mão. Então reconecta.
  for (const [id, s] of termSessions) {
    if (((s.kind === 'local' ? 'local' : s.origin) + '|' + s.tmux_session) !== dupKey) continue;
    ensureTermWin();
    const dead = !s.ws && !s.proc;
    if (dead) reviveTermSession(id, s);
    sendTerm('term-tab-activated', { tabId: id });
    return;
  }
  ensureTermWin();
  const title = termTabTitle({ alias, label, cwd, tmux_session, origin, isLocal });
  const tabId = addTermSession({ title, kind: isLocal ? 'local' : 'remote', origin: isLocal ? null : origin, tmux_session, sessionKey: key, label, cwd });
  if (isLocal) {
    spawnPtyLocal(tabId, ['tmux', 'attach', '-t', tmux_session], cwd);
  } else {
    const host = originToHost.get(origin) || '';
    const s = (settingsCfg && settingsCfg.sync) || {};
    if (!host || !s.token) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem host/token para ' + origin + '\x1b[0m\r\n' }); return; }
    openRemotePty(tabId, { host, port: s.port, token: s.token, tmux_session });
  }
}

// ---- autostart ----
function autostartEnabled() {
  try { return fs.existsSync(AUTOSTART_FILE); } catch { return false; }
}
function setAutostart(on) {
  try {
    try { fs.unlinkSync(OLD_AUTOSTART); } catch {} // limpa o .desktop da era pré-rename
    if (on) {
      // Escapa cada path pelo spec .desktop (backslash em espaço/$/`/"). Sem
      // isso, um HOME com espaço quebra o Exec no login.
      const exec = desktopEscape(process.execPath);
      const appDir = desktopEscape(__dirname);
      const desktop = `[Desktop Entry]\nType=Application\nName=AI Traffic Lights\nExec=${exec} ${appDir} --no-sandbox\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, desktop);
    } else {
      try { fs.unlinkSync(AUTOSTART_FILE); } catch {}
    }
  } catch {}
}

// Envio seguro pro renderer. A janela pode existir mas o RENDER FRAME já ter
// sido descartado (crash do renderer, reload, devtools) — aí webContents.send
// lança "Render frame was disposed before WebFrameMain could be accessed" a
// CADA tick dos timers (5s/60s), spammando o stderr sem parar. Este guard checa
// webContents vivo/não-crashed e engole qualquer erro residual de corrida.
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return false;
  try { wc.send(channel, payload); return true; }
  catch { return false; }
}

function sendSessions() {
  const list = readSessions();
  sendToRenderer('sessions', list);
  pushDetails(list);   // janela de detalhes aberta → dados AO VIVO (a cada refresh)
}

// ---- marcas de leitura (#56) ----
// Estado persistente {sessionKey: readAt} no BASE_DIR. Resolve dois problemas:
// (a) readMarks do renderer eram SÓ memória e morriam no restart; (b) marcas
// postadas por um PEER via POST /read precisam de um dono no main para serem
// aplicadas (push ao renderer) e sobreviverem ao restart. LWW por chave no
// read-marks.js (maior readAt vence — nunca "des-lê").
let readMarksState = readMarksLib.loadReadMarks(READ_MARKS_FILE);
function sendReadMarks() {
  sendToRenderer('read-marks', readMarksState);
}
// Callback do servidor de sync (net.startServer onReadMarks): merge LWW,
// persiste e empurra AO VIVO cada marca aplicada ao renderer. Retorna a qtd
// aplicada — o peer sabe (applied=0 = nada mudou, ex.: marca mais velha).
function applyReadMarks(marks) {
  const { state, applied } = readMarksLib.applyMarks(readMarksState, marks);
  if (!applied.length) return 0;
  readMarksState = state;
  readMarksLib.saveReadMarks(READ_MARKS_FILE, readMarksState);
  for (const m of applied) sendToRenderer('remote-read', m);
  return applied.length;
}

// ---- janela SOLTA de detalhes da sessão (#59) ----
// Antes: painel BLOQUEANTE dentro do overlay (backdrop em cima da lista, dados
// congelados na abertura). Agora: BrowserWindow própria frameless (padrão
// termWin), o overlay segue clicável e o main EMPURRA a sessão a cada refresh
// de 5s — deixar aberta = monitorar ao vivo. Uma janela por vez (reabrir com
// outra sessão troca o conteúdo); sessão que morre → push com s=null e a
// página mostra "sessão encerrou" em vez do último snapshot.
let detailsWin = null;
let detailsKey = null;                 // sessionKey exibida (null = janela fechada)
let detailsBoundsTimer = null;
const DETAILS_BOUNDS_FILE = path.join(BASE_DIR, 'details-window.json');
function loadDetailsBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(DETAILS_BOUNDS_FILE, 'utf8'));
    if (b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number')) return b;
  } catch {}
  return null;
}
function saveDetailsBounds() {
  if (!detailsWin || detailsWin.isDestroyed() || detailsWin.isMaximized()) return;
  clearTimeout(detailsBoundsTimer);
  detailsBoundsTimer = setTimeout(() => {
    try {
      const b = detailsWin.getBounds();
      fs.writeFileSync(DETAILS_BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    } catch {}
  }, 300);
}
// Push à janela aberta: a sessão casada por key + a marca de leitura vigente
// (readMarksState vive aqui no main — a página não tem estado próprio).
function pushDetails(list) {
  if (!detailsWin || detailsWin.isDestroyed() || !detailsKey) return;
  const s = (list || []).find((x) => sessionKey(x) === detailsKey) || null;
  const readAt = readMarksState[detailsKey] || 0;
  try { detailsWin.webContents.send('details-data', { s, readAt }); } catch {}
}
function ensureDetailsWin() {
  if (detailsWin && !detailsWin.isDestroyed()) return;
  const b = loadDetailsBounds() || {};
  // Fora de qualquer tela (monitor desconectado) → undefined, o Electron
  // centraliza no primário (mesma razão do termWin).
  const keep = boundsOnScreen(b, screen.getAllDisplays());
  detailsWin = new BrowserWindow({
    width: b.width || 420, height: b.height || 540, minWidth: 320, minHeight: 240,
    x: keep ? b.x : undefined, y: keep ? b.y : undefined,
    frame: false, transparent: true, resizable: true,
    hasShadow: false, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Mesma camada do overlay (o painel nasceu DENTRO dele): sem isto a janela
  // nova fica atrás do always-on-top do overlay sempre que se sobrepõem.
  // macOS 'floating' pelo mesmo motivo do overlay (menu bar / 2º clique tray).
  detailsWin.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  // Mesmo nível do overlay → quem reafirma por último fica na frente: o blur
  // do overlay o re-empilha (quirk Mutter), então a details reafirma o seu
  // topo ao ganhar foco — clicar nela a traz de volta pra frente.
  detailsWin.on('focus', () => { try { detailsWin.moveTop(); } catch {} });
  detailsWin.loadFile(path.join(__dirname, 'src/details.html'));
  detailsWin.webContents.once('did-finish-load', () => {
    try { pushDetails(readSessions()); } catch {}   // 1º push não espera o tick
  });
  detailsWin.on('resize', saveDetailsBounds);
  detailsWin.on('move', saveDetailsBounds);
  detailsWin.on('closed', () => { detailsWin = null; detailsKey = null; });
}
ipcMain.on('details-open', (_e, { key } = {}) => {
  if (!key) return;
  const existed = !!(detailsWin && !detailsWin.isDestroyed());
  detailsKey = key;
  ensureDetailsWin();
  if (existed) { try { detailsWin.moveTop(); detailsWin.focus(); pushDetails(readSessions()); } catch {} }
});
ipcMain.on('details-close', () => {
  if (detailsWin && !detailsWin.isDestroyed()) detailsWin.close();
});

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
      if (!s.pid) {
        // Estado sem pid (legado do adapter Kiro que virava zumbi — imune ao
        // reap por processo; o adapter não mete pid:null desde o fix da PR-46).
        // Sessão viva sempre regrava o arquivo (mtime novo); parado por >10min
        // é lixo de sessão morta — remove (mesma semântica do .tmp órfão).
        try { if (Date.now() - fs.statSync(p).mtimeMs > 600_000) { fs.unlinkSync(p); changed = true; } } catch {}
        continue;
      }
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
  if (!win || win.isDestroyed() || IS_WAYLAND || process.platform === 'darwin') return;
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
  let x = (bounds && typeof bounds.x === 'number') ? bounds.x : scrW - DEFAULT_W - 12;
  let y = (bounds && typeof bounds.y === 'number') ? bounds.y : 12;
  // Clamp: se a posição salva caiu fora das telas ativas (ex.: monitor externo
  // foi desconectado e o layout encolheu), traz de volta ao canto do primário.
  // Sem isto o WM pode relocar a janela pra um lugar inesperado ou ela some.
  const onScreen = screen.getAllDisplays().some((d) =>
    x >= d.bounds.x && x + width <= d.bounds.x + d.bounds.width &&
    y >= d.bounds.y && y + 40 <= d.bounds.y + d.bounds.height);
  if (!onScreen) {
    x = display.workArea.x + display.workAreaSize.width - width - 12;
    y = display.workArea.y + 12;
  }

  win = new BrowserWindow({
    width, height: HEADER_H + 120, // placeholder; renderer corrige via auto-height
    x, y,
    // Clamp no nível do WM: o gripper já limitava, mas o resize pela BORDA da
    // janela (resizable) ignorava MIN_W e deixava o header quebrar.
    minWidth: MIN_W, minHeight: HEADER_H,
    frame: false,
    transparent: true,
    resizable: true,
    show: process.platform !== 'darwin', // darwin: nasce oculta (1º clique no tray REVELA);
                               // Linux/Windows: nasce visível como no origin/main
    skipTaskbar: true,       // fora da barra de tarefas e do alt-tab (SKIP_TASKBAR/PAGER)
    maximizable: false,      // (não implementado no Linux; vale nas demais plataformas)
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // macOS: 'screen-saver' (NSScreenSaverWindowLevel=1000) cobre ATÉ o menu bar
  // (nível 24) — o overlay no canto superior direito taparia os ícones do tray e
  // o 2º clique ("esconder") nunca chegaria a ele. 'floating' fica acima das
  // janelas comuns, mas abaixo do menu bar. Linux mantém 'screen-saver' (X11).
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  // macOS/Space: sem isto o overlay vive num único Space — clicar no tray (ou o
  // reveal) estando em OUTRO Space não mostrava nada (a janela existe, mas fora
  // do Space atual). visibleOnAllWorkspaces faz a janela pertencer a todos os
  // Spaces, então o show() aparece no Space em uso. Trade-off: também aparece
  // sobre apps em tela cheia — aceitável pra um overlay.
  if (process.platform === 'darwin') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  }
  // Linux/Mutter ignora `maximizable` → reverte na hora qualquer maximize
  // (Super+↑, drag no topo da tela, tiling). Overlay nunca vira tela cheia.
  win.on('maximize', () => { try { win.unmaximize(); } catch {} });
  // Mutter/XWayland: o estado _NET_WM_STATE_ABOVE oscila ao perder foco (ver
  // CHANGELOG 0.6.7) — clicar em outra janela/no desktop derruba o always-on-top
  // sem passar por toggleWin/revealIfHidden. Reafirma no blur, do mesmo jeito
  // que já se faz no toggle/reveal (setAlwaysOnTop + moveTop).
  // macOS: NSWindow.Level não degrada no blur (propriedade persistente, sem o
  // quirk X11). Reafirmar moveTop() aqui re-exibiria a janela após o hide() do
  // tray-toggle (blur dispara no hide → moveTop → overlay volta sozinho).
  win.on('blur', () => {
    if (process.platform === 'darwin') return;
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    try { win.moveTop(); } catch {}
  });
  // skipTaskbar FORÇADO via wmctrl: no Mutter, com frameless+transparent+
  // alwaysOnTop, nem a option `skipTaskbar` nem setSkipTaskbar() geram o
  // hint X11 _NET_WM_STATE_SKIP_TASKBAR/PAGER de forma confiável (ele é
  // rebuildado e descartado a cada chamada de always-on-top). O `type:
  // 'toolbar'` fazia o hint na marra — mas removia _NET_WM_ACTION_MOVE,
  // travando a janela. wmctrl aplica o skip SEM tocar nas allowed actions.
  // O IS_LINUX/X11 guarda isso: no Wayland nativo wmctrl é inócuo.
  win.once('ready-to-show', () => { try { win.setSkipTaskbar(true); } catch {} applySkip(); });
  win.loadFile(path.join(__dirname, 'src/index.html'));
  win.webContents.on('did-finish-load', () => { sendSessions(); sendReadMarks(); });
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Log do renderer só com ATL_DEBUG=1 (debug off em produção).
  win.webContents.on('console-message', (_e, level, message) => {
    if (process.env.ATL_DEBUG) {
      try { fs.appendFileSync('/tmp/atl-renderer.log', `[${level}] ${message}\n`); } catch {}
    }
  });
}

// Mostrar/ocultar centralizado. No show, re-afirma skipTaskbar — alguns WMs
// resetam o hint no ciclo hide/show (bug conhecido de Electron/X11).
// A FONTE DA VERDADE do toggle é win.isVisible() (síncrono): se a janela foi
// ocultada por fora (Cmd+H no macOS, unmap do WM), o próximo clique REVELA em
// vez de esconder de novo — senão o overlay "some" por dois cliques. Havia um
// espelho `_winState` aqui, mas com o isVisible() decidindo ele nunca voltou a
// ser lido: quatro escritas, zero leituras.

function toggleWin() {
  if (!win || win.isDestroyed()) return;

  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    try { applySkip(); } catch {}
    try { win.setSkipTaskbar(true); } catch {}
    try { win.moveTop(); } catch {}
    collectAndSendUsage({ claudeFetch: true });
  }
}

// Traz o overlay de volta à tela se ele estiver OCULTO (hide). Não rouba o foco
// do teclado — só reaplica show() + skipTaskbar (continua alwaysOnTop, fora da
// barra de tarefas). Usado pela feature "revelar quando oculto" (config em
// Notificações): dispara quando um agente fica vermelho, a cota reseta ou há
// update — cada um só se a opção correspondente estiver marcada.
function revealIfHidden() {
  try {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      try { applySkip(); } catch {}
      try { win.setSkipTaskbar(true); } catch {}
      try { win.moveTop(); } catch {}
    }
  } catch { /* nunca derruba o fluxo que disparou o reveal */ }
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
      parts.push(`${t.label}: ${r.wrote ? T('ntf_installed', { a: r.added, u: r.updated }) : T('ntf_ok')}`);
    }
    if (hookInstaller.opencodeAvailable()) {
      hookInstaller.installOpencode(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
      parts.push('OpenCode: ' + T('ntf_plugin_ok'));
    }
    if (hookInstaller.kiroAvailable()) {
      hookInstaller.installKiro(path.join(__dirname, 'adapters/kiro/ai-traffic-lights.js'), BASE_DIR);
      kiroAdapter.start(chokidar, () => collect.invalidateDiscovery()); // invalida cache discovery na 1ª escrita
      parts.push('Kiro: ' + T('ntf_plugin_ok'));
    }
    notifyUser(parts.length ? parts.join(' · ') : T('ntf_none_found'));
  } catch (e) { notifyUser(T('ntf_install_fail', { msg: e.message })); }
}
function removeHookFromApp() {
  try {
    const parts = [];
    for (const id of Object.keys(hookInstaller.TARGETS)) {
      const t = hookInstaller.TARGETS[id];
      const r = hookInstaller.remove(id);
      if (r.removed) parts.push(`${t.label}: ${T('ntf_removed', { n: r.removed })}`);
    }
    if (hookInstaller.removeOpencode().removed) parts.push('OpenCode: ' + T('ntf_plugin_removed'));
    // Para o watcher SEMPRE que o usuário pede pra remover hooks — antes, quem
    // nunca tinha instalado via app não tinha cópia em <BASE_DIR> (removed=0) e o
    // stop() nunca rodava: "Remover hooks" era silenciosamente um no-op.
    kiroAdapter.stop();
    if (hookInstaller.removeKiro(BASE_DIR).removed) parts.push('Kiro: ' + T('ntf_plugin_removed'));
    notifyUser(parts.length ? parts.join(' · ') : T('ntf_nothing_installed'));
  } catch (e) { notifyUser(T('ntf_remove_fail', { msg: e.message })); }
}
// notifyUser: implementação em src/ipc/tray.js (REF passo 8). Stub reatribuído
// no boot p/ trayIpc.notifyUser (DI p/ update/focus/launcher).
let notifyUser = () => {};
// Menu reconstruível fora do createTray: os labels dependem do idioma, e a
// troca nas Preferências re-renderiza o menu ao vivo (save-settings).
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: T('tray_show_hide'), accelerator: 'Ctrl+Alt+H', click: toggleWin },
    { type: 'checkbox', label: T('tray_autostart'), checked: autostartEnabled(),
      click: (it) => { setAutostart(it.checked); } },
    // Quick Launcher: submenu com cada CLI detectado (abre o terminal e sobe).
    ...(launcherIpc.detectLaunchers().length ? [{
      label: T('launch_section'),
      submenu: launcherIpc.detectLaunchers().map((l) => ({
        label: '+ ' + AGENTS[l.id].label,
        click: () => launcherIpc.launchAgent({ agent: l.id }),
      })),
    }] : []),
    { type: 'separator' },
    { label: T('tray_install_hooks'), click: installHookFromApp },
    { label: T('tray_remove_hooks'), click: removeHookFromApp },
    { type: 'separator' },
    { label: T('tray_preferences'), click: () => settingsIpc && settingsIpc.createSettingsWindow() },
    { label: T('tray_check_updates'), click: () => updateIpc && updateIpc.checkUpdatesManual() },
    { label: T('tray_quit'), click: () => app.quit() },
  ]);
}
// (notifyUser/setTrayLevel/createTray/ícones tray + handlers notify/set-tray-level
//  movidos para src/ipc/tray.js — REF passo 8. buildTrayMenu fica aqui: é o
//  compositor do menu, injetado em createTray via callback.)

// ---- janela de Preferências (threshold de idle + atalho) ----
// (settingsWin/settingsBoundsTimer vivem em src/ipc/settings.js — REF passo 9.
//  Ficaram órfãos aqui quando createSettingsWindow foi extraído: o módulo os
//  referenciava sem enxergá-los, e abrir Preferências jogava
//  "ReferenceError: settingsWin is not defined" na cara do usuário.)
// Tamanho FIXO da janela de Preferências (não redimensionável): travado na
// altura da aba mais alta (Geral), medido no conteúdo real a 420px de largura.
// As abas mais curtas (Integração) ficam com espaço vazio; nenhuma rola.
// useContentSize faz width/height valerem para a ÁREA WEB (o .prefs preenche).
// 770px acomoda a maior aba (Notificações: 3 seções ≈ 555px de conteúdo) com
// folga — header(abas)+rodapé consomem ~170px. As abas curtas (Integração) ficam
// com espaço vazio; nenhuma rola. Em telas baixas (768px) o winH clampa à work
// area e a aba rola (header/rodapé ficam fixos).
const SETTINGS_W = 520, SETTINGS_H = 770;   // 520: 5 abas (a 5ª veio com o sync) não cabem em 420

// settings (loadSettingsBounds/saveSettingsBounds/createSettingsWindow): extraído p/ src/ipc/settings.js (REF passo 9). save-settings fica (aplicador).
// ---- IPC ----
ipcMain.on('request-sessions', sendSessions);

ipcMain.on('set-expanded', (_e, { expanded, h } = {}) => {
  if (!win || win.isDestroyed()) return;
  // expandido = altura auto (renderer pede via auto-height); recolhido = só
  // header, ou header + rodapé quando houver launchers (h vem do renderer).
  if (!expanded) {
    const [w] = win.getSize();
    const height = Math.round(h) || HEADER_H;
    // mínimo ANTES do setSize: senão o WM recusa encolher abaixo do mínimo
    // que o autosize deixou no estado expandido (janela não reduzia ao recolher).
    win.setMinimumSize(MIN_W, height);
    win.setSize(w, height, false);
  } else {
    // Expandiu: o usuário quer VER o uso → busca o % do Claude agora (lazy). O
    // cache de 5 min evita spam de abrir/fechar; fora daqui o loop não bate.
    collectAndSendUsage({ claudeFetch: true });
  }
});

// Altura automática pelo conteúdo (n linhas). Largura e posição preservadas.
// O MÍNIMO da janela acompanha o conteúdo: não dá pra arrastar pra menos e
// cortar sessões — o overlay sempre cabe tudo (até o teto da tela, onde rola).
ipcMain.on('auto-height', (_e, h) => {
  if (!win || win.isDestroyed()) return;
  const clamped = Math.max(MIN_H, Math.min(Math.round(h), maxOverlayH()));
  const [w] = win.getSize();
  // mínimo ANTES do setSize: ao encolher, o WM respeita o mínimo anterior e
  // rejeitaria o setSize abaixo dele (janela não reduzia).
  win.setMinimumSize(MIN_W, clamped);
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
// (handler 'focus' movido para src/ipc/focus.js — REF passo 4)

// (handlers get-aliases/set-alias movidos para src/ipc/aliases.js — REF passo 7)

// Settings: leitura (Preferências), gravação (aplica atalho + avisa overlay),
// (handlers get-settings/get-lang/get-version/open-external/get-repo-url movidos p/ src/ipc/settings.js — REF passo 9)
ipcMain.on('save-settings', (_e, cfg) => {
  // No live-apply isto dispara a CADA mudança nas Preferências. Só refaz o
  // trabalho caro quando o valor relevante mudou de fato (evita re-registrar o
  // globalShortcut e reconstruir o tray a cada tick de arraste do slider).
  const prevShortcut = settingsCfg.shortcut, prevLang = settingsCfg.lang;
  const prevChannel = settingsCfg.updateChannel;
  settingsCfg = persistSettings(cfg);
  applySync();                                                 // re-avalia servidor/poller (sync)
  if (settingsCfg.shortcut !== prevShortcut) applyShortcut();   // re-registra só se o atalho mudou
  if (settingsCfg.updateChannel !== prevChannel && updateIpc) updateIpc.onChannelChanged();
  if (settingsCfg.lang !== prevLang) {                          // idioma só se mudou
    applyLang();
    if (trayIpc) trayIpc.refreshMenu();                          // labels do tray no idioma novo (no-op no macOS: o menu é montado a cada right-click)
  }
  sendToRenderer('settings-changed', settingsCfg);
});
// (handler 'open-settings' movido p/ src/ipc/settings.js — REF passo 9)

// Sync multi-máquina: lê/gravar SÓ o sub-objeto sync (validado em persistSettings).
// Sync é feature beta: get-sync devolve null fora de uma build beta (a aba de
// Preferências some; ninguém lê/grava sync na estável).
ipcMain.handle('get-sync', () => SYNC_AVAILABLE ? ((settingsCfg && settingsCfg.sync) || null) : null);
ipcMain.on('set-sync', (_e, syncCfg) => {
  if (!SYNC_AVAILABLE) return;
  settingsCfg = persistSettings({ sync: syncCfg });
  applySync();
  sendToRenderer('settings-changed', settingsCfg);
});
// Ver prompt de uma sessão: local lê direto do disco; remoto busca /transcript no peer.
ipcMain.handle('fetch-transcript', async (_e, { origin, key, n }) => {
  // NaN (n não-numérico vindo do renderer) atravessaria Math.min/max e burlaria
  // o teto de 50 — mesmo clamp defensivo do handler /transcript no net.js.
  const p = parseInt(n || 20, 10);
  const N = Math.max(1, Math.min(50, Number.isFinite(p) ? p : 20));
  if (!origin || origin === 'local') {
    try { const tp = collect.findTranscript(key); return tp ? transcript.lastMessages(tp, N) : []; }
    catch { return []; }
  }
  const s = (settingsCfg && settingsCfg.sync) || {};
  const host = originToHost.get(origin);
  if (!host) return [];
  return net.fetchTranscriptFromPeer({ host, port: s.port, token: s.token, key, n: N, onlineSet });
});

// #56: clique "marcar como lido" no overlay. Sempre persiste no read-marks
// (sobrevive restart — o renderer já pintou o cinza otimista na hora). Se a
// sessão é de um PEER, além disso avisa a ORIGEM: posta a chave reescrita no
// namespace DELA (rewriteKeyOrigin 'peer:1234' → 'local:1234') e a origem
// passa a exportar readIdleSec pra TODOS os peers no próximo /sessions.
// O readAt postado NÃO leva folga: o par (readAt, now) é auto-corretor. O
// readAt foi ancorado ao relógio local pelo MESMO poll que ancorou o
// last_event_ts (ambos somam D = latência+skew); o drift `agora - now`
// calculado na origem remove exatamente esse D. O resíduo é a soma das
// latências (poll + POST), sempre ≥ 0 — nunca derruba o readAt abaixo do
// last_event_ts da origem. Folga extra marcaria "lido" um evento que chegasse
// até 2s DEPOIS do clique.
ipcMain.on('mark-read', (_e, { key, readAt, origin } = {}) => {
  if (typeof key !== 'string' || !key || !(Number(readAt) > 0)) return;
  const at = Math.floor(Number(readAt));
  applyReadMarks([{ key, readAt: at }]);
  if (origin && origin !== 'local') {
    const host = originToHost.get(origin);
    const s = (settingsCfg && settingsCfg.sync) || {};
    if (host && s.enabled && s.token) {
      net.postReadToPeer({
        host, port: s.port, token: s.token,
        now: Math.floor(Date.now() / 1000),
        marks: [{ key: rewriteKeyOrigin(key, origin, 'local'), readAt: at }],
      }).catch(() => {});   // fire-and-forget: falha não perde nada (o estado local já está persistido)
    }
  }
});

// Menu de contexto da linha (renderer): copiar chave/cwd/comando de attach.
// 'send' (não invoke): o renderer não espera resposta. Valida tipo e tamanho —
// clipboard é um recurso global, o renderer nunca deve estourá-lo com lixo.
ipcMain.on('copy-text', (_e, text) => {
  if (typeof text !== 'string' || !text || text.length > 4096) return;
  clipboard.writeText(text);
});

// Preferências espelha o tray: autostart + hooks. Mostrar/ocultar e sair
// reusam os canais 'toggle-visibility' e 'quit' já registrados.
ipcMain.handle('get-autostart', () => autostartEnabled());
ipcMain.on('set-autostart', (_e, on) => setAutostart(!!on));
ipcMain.on('install-hooks', () => installHookFromApp());
ipcMain.on('remove-hooks', () => removeHookFromApp());

// Notificação no vermelho.
// (handler 'notify' movido para src/ipc/tray.js — REF passo 8)

// (handlers pick-sound-file/get-sound-bytes movidos p/ src/ipc/settings.js — REF passo 9)

// Tray: mostrar/ocultar, autostart, sair.
ipcMain.on('toggle-visibility', toggleWin);
// Overlay pede pra voltar à frente (renderer detectou transição p/ vermelho).
ipcMain.on('reveal-overlay', () => { if (settingsCfg.revealOnRed) revealIfHidden(); });

// Tray dinâmico: renderer manda a pior cor + contagem a cada render.
// (handler 'set-tray-level' movido para src/ipc/tray.js — REF passo 8)

// Quick Launcher: lista de agentes detectados + sobe um agente num terminal.
// (handlers get-launchers/launch-agent movidos para src/ipc/launcher.js — REF passo 5)
ipcMain.on('attach-remote', (_e, t) => attachRemote(t || {}));   // attach tmux (local ou via peer)

// ---- sync multi-máquina (P2P): servidor + poller, OPT-IN (fase 2) ----
// Sessões remotas dos peers são mergeadas em readSessions(); chegam com `origin`
// = nome do peer → sessionKey (namespaced) separa das locais. Idempotente: só
// derruba/sobe o lado que mudou de desejo/config. Sem efeito com sync desligado
// (superfície zero). Token vazio => nada sobe (fail-safe).
let remoteSessions = new Map();   // peerHost -> sessions[] (já com origin)
let originToHost = new Map();     // peerNodeName -> peerHost (p/ fetch-transcript remoto)
const livePeers = new Set();      // hosts que responderam /sessions (ATL ligado) — o menu + só mostra vivos
let syncServer = null, syncServerKey = null;
// Derruba o servidor de sync E os shells /pty JÁ conectados. server.close()
// sozinho só para de aceitar conexões novas: desligar o sync (ou revogar o
// token) deixava um shell remoto em curso vivo indefinidamente — o oposto do
// que o toggle promete (PR-32 #07). closeAllPty só existe com allowAttach.
function closeSyncServer() {
  if (!syncServer) return;
  try { if (syncServer.closeAllPty) syncServer.closeAllPty(); } catch {}
  try { syncServer.close(); } catch {}
  syncServer = null; syncServerKey = null;
}
let stopPoll = null, pollKey = null;
let settingsIpc = null;   // settings window module (src/ipc/settings.js) — setado no boot, lido no tray
let _kiroPrecisaInstalar = false;   // Kiro na máquina, adapter não instalado
let trayIpc = null;   // tray+notify module (src/ipc/tray.js) — setado no boot PRIMEIRO (fornece notifyUser)
let updateIpc = null;   // auto-update module (src/ipc/update.js) — setado no boot, lido no tray
let launcherIpc = null;   // launcher module (src/ipc/launcher.js) — setado no boot, lido no tray
let onlineSet = null, onlineTimer = null;   // peers online per Tailscale (gate do poller)
function syncNodeName() { return (settingsCfg.sync && settingsCfg.sync.node) || os.hostname() || 'local'; }
function applySync() {
  if (!SYNC_AVAILABLE) return;   // feature beta: estável/fonte nunca sobem servidor/poller
  const s = (settingsCfg && settingsCfg.sync) || {};
  const tok = typeof s.token === 'string' ? s.token : '';
  // SERVIDOR (compartilhar minhas sessões): binda no IP da tailnet
  // (detectTailnetIP) — peers alcançam direto em http://<ip>:<porta>; auth por
  // token + WireGuard E2E (sem tailscale serve). Reinicia só se a config mudou.
  // O desligamento passa por closeSyncServer, que derruba TAMBÉM os shells /pty
  // já conectados (PR-32 #07).
  // O bindHost FAZ PARTE da chave: enquanto a detecção falha (tailscale ainda
  // subindo no boot), binda no 127.0.0.1; o re-check de 30s (abaixo) re-resolve
  // e, quando o 100.x aparece, a chave muda e o servidor rebinda — o "próximo
  // ciclo" que o net.js promete (detectTailnetIP não cacheia null p/ isso).
  const bindHost = process.env.ATL_SYNC_BIND || net.detectTailnetIP();
  const srvKey = (s.enabled && s.share && tok) ? `${s.port}|${tok}|${s.shareTranscripts ? 1 : 0}|${s.allowAttach ? 1 : 0}|${syncNodeName()}|${bindHost || ''}` : '';
  if (!srvKey && syncServer) { closeSyncServer(); }
  if (srvKey && srvKey !== syncServerKey) {
    if (syncServer) { closeSyncServer(); }
    try {
      syncServer = net.startServer({
        port: s.port, token: tok, nodeName: syncNodeName(), shareTranscripts: !!s.shareTranscripts, allowAttach: !!s.allowAttach, ptySpawn: createPty, bindHost,
        // Locais ANOTADAS com a conta Claude (modal de detalhes no peer) —
        // annotate é idempotente (cache por pid) e pula remota. NÃO usar o
        // wrapper readSessions() aqui: ele mergeia sessões de outros peers, e
        // o exportSession sobrescreveria `origin` com o NOSSO nome.
        getSessions: () => annotateClaudeAccounts(collect.readSessions()),
        getTranscript: (key, n) => {
          try { const tp = collect.findTranscript(key); return tp ? transcript.lastMessages(tp, n) : []; }
          catch { return []; }
        },
        onReadMarks: applyReadMarks,   // POST /read (#56): marca vinda de peer → merge+persiste+push
        readAtFor: (s) => readMarksState[sessionKey(s)],   // #56: marca vigente vira readIdleSec no /sessions
      });
      syncServerKey = srvKey;
      try { console.log('[sync] server up ' + (bindHost || '127.0.0.1') + ':' + s.port + ' (' + syncNodeName() + (bindHost ? '' : ' — localhost só, sem tailscale?') + ')'); } catch {}
    } catch (e) { try { console.log('[sync] server falhou: ' + e.message); } catch {} syncServer = null; syncServerKey = null; }
  }
  // CLIENTE (observar peers): poll de /sessions a cada 5s.
  const pKey = (s.enabled && Array.isArray(s.peers) && s.peers.length && tok) ? `${s.port}|${tok}|${s.peers.map((p) => p.host).join(',')}` : '';
  if (!pKey && stopPoll) { stopPoll(); stopPoll = null; pollKey = null; clearInterval(onlineTimer); onlineTimer = null; remoteSessions.clear(); livePeers.clear(); sendSessions(); }
  if (pKey && pKey !== pollKey) {
    if (stopPoll) { stopPoll(); }
    // A LISTA de peers mudou (alguém entrou ou SAIU). Sem esta limpeza, as
    // sessões de um peer removido ficavam em remoteSessions para sempre: o
    // last_event_ts nunca avança, a sessão escala para vermelho e apita alerta
    // falso — o fantasma pela via da REMOÇÃO (mesmo sintoma do PR-32 #10, cujo
    // fix cobria queda do peer e desligamento do sync, mas não a edição da lista).
    remoteSessions.clear(); originToHost.clear(); livePeers.clear(); sendSessions();
    // Gate Tailscale: só tenta rede em peers que o Tailscale diz online. Set
    // refresh a cada 10s (barato, local); null => sem tailscale => sem gate (cai p/ backoff).
    onlineSet = net.tailscaleOnlineSet();
    clearInterval(onlineTimer);
    onlineTimer = setInterval(() => { onlineSet = net.tailscaleOnlineSet(); }, 10000);
    stopPoll = net.pollPeers({
      peers: s.peers, port: s.port, token: tok,
      isOnline: (h) => net.peerOnline(onlineSet, h),   // PR-32 #16: casa hostname curto / FQDN / host:porta / IP
      onSessions: (host, sessions) => {
        remoteSessions.set(host, sessions);
        livePeers.add(host);   // ATL ligado no peer → habilita no menu + da termWin
        for (const s of sessions) if (s && s.origin) originToHost.set(s.origin, host); // p/ fetch-transcript remoto
        // #56: leitura marcada NA ORIGEM (clique lá, ou POST /read de um 3º)
        // chega como readIdleSec — idade relativa no relógio DO PEER. Re-ancora
        // no relógio LOCAL (agora - readIdleSec), o MESMO padrão do anchorRemote
        // que reescreveu o last_event_ts destas sessões: a comparação
        // `last_event_ts <= readAt` do state-machine corre entre dois
        // timestamps do MESMO relógio. Chave no namespace do RECEPTOR
        // (sessionKey → 'peer:<pid>'), igual à marca otimista do clique local.
        const nowS = Math.floor(Date.now() / 1000);
        const marks = [];
        for (const s of sessions) {
          if (!s || s.readIdleSec == null) continue;
          const k = sessionKey(s);
          const at = nowS - Math.max(0, s.readIdleSec | 0);
          delete s.readIdleSec;   // consumido aqui: não vaza ao renderer
          if (k && at > 0) marks.push({ key: k, readAt: at });
        }
        if (marks.length) applyReadMarks(marks);
        sendSessions();
        // Re-semeadura das marcas do peer (achado do review do #56): o renderer
        // PODA as marks das sessões que saíram da lista (peer caiu →
        // remoteSessions.delete → render → liveKeys sem a chave). Na reconexão
        // a marca re-ancorada chega IGUAL à persistida — LWW pula, `applied`
        // fica vazio e nada era empurrado: a sessão voltava vermelha apesar de
        // lida (o estado completo só re-chegava no did-finish-load). Re-envia o
        // estado VIGENTE das chaves vivas DEPOIS do push de sessões — o render
        // que recebe as sessões rodaria o prune antes se a mark chegasse
        // primeiro. Handler do renderer é LWW-idempotente: chave já em dia não
        // re-renderiza, chave podada volta a pintar cinza.
        const reseed = readMarksLib.reseedMarks(
          readMarksState,
          sessions.map((s) => (s ? sessionKey(s) : '')).filter(Boolean),
        );
        if (Object.keys(reseed).length) sendToRenderer('read-marks', reseed);
      },
      // Peer caiu → DESCARTA as sessões dele. Antes só saía de livePeers (menu
      // da termWin) e remoteSessions ficava intacto: as sessões do peer morto
      // seguiam na lista indefinidamente, com o idle crescendo — viravam
      // fantasmas que escalam pra vermelho e apitam alerta falso. remoteSessions
      // só era limpo no teardown global do sync (PR-32 #10; o fix anterior
      // cobria só o desligar-o-sync, não a queda de um peer).
      onPeerState: (host, online) => {
        try { console.log('[sync] peer ' + host + ' ' + (online ? 'online' : 'offline (backoff)')); } catch {}
        if (online) { livePeers.add(host); return; }
        livePeers.delete(host);
        if (remoteSessions.delete(host)) sendSessions();   // some da lista na hora
      },
    });
    pollKey = pKey;
  }
}

// Re-check do sync a cada 30s (idempotente: cada peça só mexe no estado quando
// a chave muda). É o ciclo que torna o rebind da tailnet real: no boot com
// Tailscale ainda subindo, o servidor fica no 127.0.0.1; aqui ele re-resolve o
// IP e o srvKey — que inclui o bindHost — muda, rebindando no 100.x.
setInterval(() => {
  try { if (settingsCfg && settingsCfg.sync && settingsCfg.sync.enabled) applySync(); } catch {}
}, 30000);

// ---- Janela Terminal (abas) — separada do overlay, maximizável ----
// O overlay NÃO hospeda mais o terminal: o estado dos pty/ws vive aqui (Map
// termSessions) e o renderer (src/term.html) só desenha abas + xterm, falando
// por IPC (tabId). Assim o overlay fica leve (não cresce, não bloqueia cliques).
let ptyLib = null;
// PATH garantido pro pty: electron/Chromium no Linux pode herdar PATH restrito
// (sem /usr/bin) → tmux/bash não achados → o auto-wrap em tmux falhava silenciosamente.
// Acrescenta os dirs base no fim (não sobrescreve o que já tá lá).
function ptyEnv() {
  const env = Object.assign({}, process.env);
  const cur = String(env.PATH || '').split(':').filter(Boolean);
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) if (!cur.includes(d)) cur.push(d);
  env.PATH = cur.join(':');
  return env;
}
// true se o bin existe no PATH do main OU nos dirs base (fallback robusto ao scanPathBin).
function hasBin(bin) {
  if (scanPathBin(bin)) return true;
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) { try { if (fs.existsSync(d + '/' + bin)) return true; } catch {} }
  return false;
}
function ptyEnsure() { if (!ptyLib) { try { ptyLib = require('node-pty'); } catch (e) { try { console.log('[pty] node-pty indisponível: ' + e.message); } catch {} } } return ptyLib; }
// factory p/ o SERVIDOR /pty (DI em net.startServer): 1 node-pty por conexão
// remota (peer attachando em MIM). Devolve handle {write,resize,pause,resume,kill}.
function createPty(cmd, cols, rows, { onData, onExit }) {
  const p = ptyEnsure(); if (!p) throw new Error('node-pty indisponível');
  const proc = p.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: process.env.HOME, env: ptyEnv() });
  proc.onData(onData); proc.onExit(onExit);
  return {
    write: (d) => { try { proc.write(d); } catch {} },
    resize: (c, r) => { try { proc.resize(c, r); } catch {} },
    pause: () => { try { proc.pause(); } catch {} },
    resume: () => { try { proc.resume(); } catch {} },
    kill: () => { try { proc.kill(); } catch {} },
  };
}

let termWin = null;
const termSessions = new Map();   // tabId -> { title, kind, origin, tmux_session, proc, ws, cols, rows }
let tabSeq = 0;
let termWinReady = false;         // term.html carregou? Fila de IPCs até did-finish-load — evita perder term-tab-added/pty-out na 1ª abertura (janela vinha vazia).
const termQueue = [];
// A termWin precisa estar VISÍVEL e ESTÁVEL (WM mapeou) quando o renderer cria o
// xterm (term.open). Abrir o xterm durante a transição hide→show (X11 frameless
// remapeia assíncrono) deixa o render quebrado: a aba vinha preta e nem resize
// recuperava. O main SÓ entrega o term-tab-added quando a janela está estável;
// até lá, guarda aqui. (document.hidden no renderer não detecta hide/show de
// BrowserWindow — por isso o controle fica aqui, onde isVisible() é confiável.)
let termWinStable = false;
const pendingTermTabs = [];
function flushPendingTermTabs() {
  termWinStable = true;
  if (!termWinReady || !termWin || termWin.isDestroyed()) return;
  for (const p of pendingTermTabs.splice(0)) { try { termWin.webContents.send('term-tab-added', p); } catch {} }
}
function sendTerm(ch, payload) {
  if (!termWin || termWin.isDestroyed()) return;
  if (!termWinReady) { termQueue.push([ch, payload]); return; }
  try { termWin.webContents.send(ch, payload); } catch {}
}
let termBoundsTimer = null;
function loadTermBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(TERM_BOUNDS_FILE, 'utf8'));
    if (b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number')) return b;
  } catch {}
  return null;
}
function saveTermBounds() {
  if (!termWin || termWin.isDestroyed() || termWin.isMaximized()) return;   // não persiste maximizada (senão reabre do tamanho da tela sem estar max)
  clearTimeout(termBoundsTimer);
  termBoundsTimer = setTimeout(() => {
    try {
      const b = termWin.getBounds();
      fs.writeFileSync(TERM_BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    } catch {}
  }, 300);
}
// Reexibe a janela Terminal depois de um hide(). No Linux/X11 uma janela
// `frame:false` + `transparent:true` costuma ficar presa em WM_STATE=Withdrawn:
// o show() do Electron pede o mapeamento, mas o WM ignora e a janela some da
// lista de janelas — o app parecia "não reabrir", ou reabrir vazio, quando na
// verdade o conteúdo estava intacto e a JANELA é que nunca voltou.
// showInactive()+show() força o remapeamento; o restore() cobre o caso de ela
// ter sido minimizada antes de esconder.
function revealTermWin() {
  if (!termWin || termWin.isDestroyed()) return;
  try {
    termWinStable = false;   // transição hide→show: não criar xterms até o WM mapear
    if (termWin.isMinimized()) termWin.restore();
    termWin.showInactive();
    termWin.show();
    termWin.moveTop();
    termWin.focus();
    // Reabrir a termWin (hide→show): o WM no X11 frameless+transparent remapeia a
    // janela de forma ASSÍNCRONA. Criar/repintar o xterm antes do remapeamento
    // deixa o canvas preto. Com o delay o WM já mapeou → a janela está ESTÁVEL:
    // libera os term-tab-added guardados e avisa o renderer pra repintar.
    setTimeout(() => {
      if (!termWin || termWin.isDestroyed() || !termWin.isVisible()) return;
      flushPendingTermTabs();
      sendTerm('term-shown');
    }, 120);
  } catch {}
}

function ensureTermWin() {
  if (termWin && !termWin.isDestroyed()) { revealTermWin(); return termWin; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = loadTermBounds();
  const w = (b && b.width) || Math.min(960, Math.max(640, Math.round(wa.width * 0.6)));
  const h = (b && b.height) || Math.min(680, Math.max(380, Math.round(wa.height * 0.7)));
  // Valida a posição salva contra TODAS as telas, não só a primária: num setup
  // multi-monitor a janela movida pro monitor da esquerda (x menor) ou da direita
  // (x além da largura do primário) tinha a posição DESCARTADA em silêncio a cada
  // reabertura, anulando o persist (PR-32 #19). Fora de qualquer tela (monitor
  // desconectado) → undefined, e o Electron centraliza no primário.
  const keep = boundsOnScreen(b, screen.getAllDisplays());
  const x = keep ? b.x : undefined;
  const y = keep ? b.y : undefined;
  termWin = new BrowserWindow({
    width: w, height: h, minWidth: 560, minHeight: 320, title: 'ATL Terminal', x, y,
    frame: false, transparent: true, resizable: true, maximizable: true, fullscreenable: true,
    hasShadow: false, backgroundColor: '#00000000',
    alwaysOnTop: false, skipTaskbar: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  termWin.loadFile(path.join(__dirname, 'src/term.html'));
  termWin.webContents.once('did-finish-load', () => {
    termWinReady = true;
    for (const [ch, p] of termQueue.splice(0)) { try { termWin.webContents.send(ch, p); } catch {} }
    sendTerm('term-maximized', !!termWin.isMaximized());   // estado inicial: renderer tira o radius se maximizada
    flushPendingTermTabs();   // 1ª carga: janela nasce visível/estável → libera abas guardadas
  });
  // Janela reapareceu (show do ensureTermWin, restore do WM): o renderer precisa
  // REPINTAR o xterm — enquanto esteve oculta o canvas foi descartado e o buffer
  // não. Sem isso a aba reabre em branco com o tmux vivo do outro lado.
  termWin.on('restore', () => sendTerm('term-shown'));
  // (re)mostrar a termWin (× = hide → clicar de novo = show): o canvas do xterm é
  // descartado enquanto a janela esteve oculta e o renderer precisa repintar.
  // No Linux/X11 o visibilitychange é unreliable pra hide/show de BrowserWindow,
  // então avisamos pelo canal do main (igual ao restore) — sem isto a aba
  // reabria em branco, com o tmux/pty vivo do outro lado.
  termWin.on('show', () => sendTerm('term-shown'));
  termWin.on('maximize', () => sendTerm('term-maximized', true));
  termWin.on('unmaximize', () => sendTerm('term-maximized', false));
  termWin.on('resize', saveTermBounds);   // persiste tamanho/posição (debounce; ignora se maximizada)
  termWin.on('move', saveTermBounds);
  // Fechar a janela (Alt+F4, X do WM, "Sair" no tray) MATA os ptys/WS antes de
  // zerar o Map. Sem isso o clear() apagava as referências e o will-quit não
  // tinha mais o que matar → vazava um node-pty + tmux por aba, a cada
  // abre/fecha (PR-32 #08).
  termWin.on('closed', () => {
    for (const id of [...termSessions.keys()]) destroyTermSession(id);
    termWin = null; termWinReady = false; termWinStable = false; termQueue.length = 0; pendingTermTabs.length = 0; termSessions.clear();
  });
  return termWin;
}
function destroyTermSession(tabId) {
  const s = termSessions.get(tabId); if (!s) return;
  try { if (s.proc) s.proc.kill(); } catch {}
  if (s.ws) { try { s.ws.close(); } catch {} }
  termSessions.delete(tabId);
}
function addTermSession({ title, kind, origin, tmux_session, sessionKey, label, cwd }) {
  const tabId = ++tabSeq;
  // label/cwd ficam guardados p/ RECONSTRUIR o título quando o alias é removido
  // (rename pra vazio) — sem eles a aba cairia no 'tmux: <sessão>'.
  const ownerId = termWin && !termWin.isDestroyed() ? termWin.webContents.id : null;
  termSessions.set(tabId, { title, kind, origin, tmux_session, sessionKey: sessionKey || null, label: label || null, cwd: cwd || null, ownerId, proc: null, ws: null, cols: 80, rows: 24 });
  // Só entrega o term-tab-added com a termWin ESTÁVEL; criar o xterm antes (na
  // transição hide→show) quebra o render. O pty-out que chega antes o renderer
  // bufferiza (term ainda não existe lá).
  if (termWinStable && termWinReady) sendTerm('term-tab-added', { tabId, title });
  else pendingTermTabs.push({ tabId, title });
  return tabId;
}
function closeTermSession(tabId) {
  destroyTermSession(tabId);
  sendTerm('term-tab-removed', { tabId });
  if (!termSessions.size && termWin && !termWin.isDestroyed()) {
    // FECHA (não hide) a termWin ao despovoar. Uma termWin REAPROVEITADA
    // (hide→show) não volta a renderizar o xterm de uma aba reaberta (fica preta,
    // mesmo com o ws mandando output e o write sendo chamado) — só uma janela
    // NOVA, criada no próximo attach via did-finish-load, renderiza certo (é o
    // caminho da 1ª aba, que sempre funcionou). O close descarta a page; o
    // ensureTermWin recria uma fresca.
    try { termWin.close(); } catch {}
  }
}
// spawn node-pty local pra uma aba (shell novo ou tmux attach local).
function spawnPtyLocal(tabId, cmd, cwd) {
  const p = ptyEnsure(); const s = termSessions.get(tabId);
  if (!p || !s) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mnode-pty indisponível\x1b[0m\r\n' }); return; }
  try { console.log('[term] spawn tabId=' + tabId + ' cmd=' + JSON.stringify(cmd));
    const proc = p.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: cwd || process.env.HOME, env: ptyEnv() });
    proc.onData((d) => sendTerm('pty-out', { tabId, data: d }));
    // Zera s.proc no exit: sem isso a aba fica com uma referência a um processo
    // MORTO e o teste de "conexão caiu" (!ws && !proc) nunca dispara — o revive
    // não acontecia e a aba reabria vazia.
    proc.onExit(() => { const cur = termSessions.get(tabId); if (cur && cur.proc === proc) cur.proc = null; sendTerm('pty-exit', { tabId }); });
    s.proc = proc;
    // mesma razão do remoto: o spawn usou s.cols/s.rows; re-fit pega o tamanho real.
    sendTerm('term-refit', { tabId });
  } catch (e) { console.log('[term] spawn FAIL tabId=' + tabId + ': ' + (e.message || e)); sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m' + (e.message || e) + '\x1b[0m\r\n' }); }
}
// cliente WebSocket do /pty remoto pra uma aba (attach ao vivo no peer).
function openRemotePty(tabId, { host, port, token, tmux_session }) {
  const s = termSessions.get(tabId); if (!s) return;
  const authority = net.peerAuthority(host, port || 47474);
  if (!authority || !net.peerOnline(onlineSet, host)) {
    sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mpeer não confirmado pelo Tailscale\x1b[0m\r\n' });
    return;
  }
  const url = 'ws://' + authority + '/pty';
  let ws;
  try { ws = new (require('ws'))(url, { headers: { Authorization: 'Bearer ' + token } }); } catch (e) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mWebSocket falhou: ' + e.message + '\x1b[0m\r\n' }); return; }
  s.ws = ws;
  ws.on('open', () => {
    try { ws.send(JSON.stringify({ type: 'start', tmux_session, cols: s.cols, rows: s.rows })); } catch {}
    // o `start` usa s.cols/s.rows (possivelmente defasados). Pede ao renderer
    // o tamanho REAL da janela e re-envia → tmux remoto desenha no tamanho certo.
    sendTerm('term-refit', { tabId });
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'out') sendTerm('pty-out', { tabId, data: m.data });
    else if (m.type === 'exit') sendTerm('pty-exit', { tabId });
    else if (m.type === 'error') sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m[remoto] ' + m.msg + '\x1b[0m\r\n' });
  });
  ws.on('error', (e) => sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m[remoto] ' + (e.message || 'erro de conexão') + '\x1b[0m\r\n' }));
  // Queda de conexão (peer dorme, wifi cai, sync desligado do outro lado) é o
  // modo de falha MAIS comum e não emite 'error' — só 'close'. Sem tratar, a
  // aba ficava "assombrada": parecia viva, não respondia, sem aviso nenhum
  // (PR-32 #17). Avisa e encerra a aba, como no fim de um pty local.
  ws.on('close', () => {
    const cur = termSessions.get(tabId);
    if (!cur || cur.ws !== ws) return;   // aba já fechada/reconectada — não polui a nova
    cur.ws = null;
    sendTerm('pty-out', { tabId, data: '\r\n\x1b[33m[remoto] conexão encerrada\x1b[0m\r\n' });
    sendTerm('pty-exit', { tabId });
  });
}
// ---- handlers IPC da janela Terminal (abas) ----
function isTermSender(e) {
  return !!(e && termWin && !termWin.isDestroyed() && e.sender === termWin.webContents);
}
function termSessionFor(e, tabId) {
  if (!isTermSender(e)) return null;
  const s = termSessions.get(tabId);
  return s && s.ownerId === e.sender.id ? s : null;
}
ipcMain.on('term-new-shell', (e, host) => {
  if (!isTermSender(e)) return;
  const local = host === undefined || host === 'local';
  const cfg = (settingsCfg && settingsCfg.sync) || {};
  const peer = !local && typeof host === 'string' && Array.isArray(cfg.peers)
    ? cfg.peers.find((p) => p && p.host === host && livePeers.has(p.host) && net.peerOnline(onlineSet, p.host))
    : null;
  if (!local && !peer) return;
  if (!local) {            // shell novo num peer remoto (via /pty, sem tmux_session)
    const tabId = addTermSession({ title: host + ' · shell', kind: 'remote', origin: host });
    if (!cfg.token) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem token sync configurado\x1b[0m\r\n' }); return; }
    openRemotePty(tabId, { host, port: cfg.port, token: cfg.token });   // sem tmux_session → shell novo no peer
  } else {
    const tabId = addTermSession({ title: 'shell', kind: 'local' });
    const hasTmux = hasBin('tmux');
    const cmd = hasTmux ? launcher.tmuxWrap([process.env.SHELL || 'bash'], launcher.tmuxSessionName('shell') + '-' + Date.now().toString(36)) : [process.env.SHELL || 'bash'];
    spawnPtyLocal(tabId, cmd, process.env.HOME);
  }
});
ipcMain.handle('term-hosts', (e) => {
  if (!isTermSender(e)) return [];
  const peers = ((settingsCfg && settingsCfg.sync) || {}).peers || [];
  const live = peers.filter((p) => livePeers.has(p.host) && net.peerOnline(onlineSet, p.host));
  return [{ id: 'local', label: 'local' }, ...live.map((p) => ({ id: p.host, label: p.name || p.host }))];
});
ipcMain.on('term-win-control', (e, op) => {   // chrome custom frameless: min/max/close
  if (!isTermSender(e)) return;
  try {
    if (op === 'min') termWin.minimize();
    else if (op === 'max') termWin.isMaximized() ? termWin.unmaximize() : termWin.maximize();
    else if (op === 'close') termWin.hide();
  } catch {}
});
// ---- resize via grip (frameless+transparent não tem resize nativo no Linux) ----
let termResizeStart = null;
ipcMain.on('resize-term-start', (e) => { if (isTermSender(e)) termResizeStart = termWin.getSize(); });
ipcMain.on('resize-term-move', (e, p) => {
  if (!isTermSender(e) || !termResizeStart || !p || !Number.isFinite(p.dw) || !Number.isFinite(p.dh)) return;
  const { dw, dh } = p;
  try { termWin.setSize(Math.max(560, Math.round(termResizeStart[0] + dw)), Math.max(320, Math.round(termResizeStart[1] + dh)), false); } catch {}
});
ipcMain.on('resize-term-end', (e) => { if (isTermSender(e)) termResizeStart = null; });
// Ativação é visual no renderer (roteamento é por tabId, que vem no input/resize),
// mas aproveitamos pra RELIGAR a aba se a conexão dela tiver morrido — quem clica
// numa aba vazia quer o conteúdo de volta, e sem isto o único caminho era fechar
// e reabrir pela lista.
ipcMain.on('term-switch-tab', (e, tabId) => {
  const s = termSessionFor(e, tabId);
  if (s && !s.ws && !s.proc) reviveTermSession(tabId, s);
});
ipcMain.on('term-close-tab', (e, tabId) => { if (termSessionFor(e, tabId)) closeTermSession(tabId); });
ipcMain.on('term-input', (e, p) => {
  if (!p || typeof p.data !== 'string') return;
  const { tabId, data } = p;
  const s = termSessionFor(e, tabId); if (!s) return;
  if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'in', data })); } catch {} }
  else if (s.proc) { try { s.proc.write(data); } catch {} }
});
ipcMain.on('term-resize', (e, p) => {
  if (!p || !Number.isInteger(p.cols) || !Number.isInteger(p.rows) || p.cols < 1 || p.rows < 1) return;
  const { tabId, cols, rows } = p;
  const s = termSessionFor(e, tabId); if (!s) return;
  if (cols > 0) s.cols = cols;
  if (rows > 0) s.rows = rows;
  if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {} }
  else if (s.proc) { try { s.proc.resize(cols, rows); } catch {} }
});

app.whenReady().then(() => {
  // Sem menu de aplicação: o menu default do Electron registra aceleradores
  // globais (Ctrl+W fecha a janela, Ctrl+R recarrega o renderer, Ctrl+Q mata o
  // app) que são teclas ORDINÁRIAS dentro de um shell na janela Terminal —
  // digitá-las destruía a janela/sessão. autoHideMenuBar só ESCONDE a barra, os
  // aceleradores seguem ativos; remover o menu é o que os desliga (PR-32 #15).
  // NÃO no macOS: lá o menu é do sistema e carrega Cmd+C/V/Q/W — removê-lo
  // quebraria o colar no campo de token das Preferências (Cmd+W/R/Q também não
  // colidem com o shell, que usa Ctrl).
  if (process.platform !== 'darwin') { try { Menu.setApplicationMenu(null); } catch {} }
  migrateOldBase();                              // dados da era claude-traffic-light
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  // mantém a cópia estável do hook em dia (o settings.json aponta pra ela)
  try { hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR); } catch {}
  // idem pro plugin do OpenCode (só se o usuário já o instalou)
  hookInstaller.syncOpencodeIfInstalled(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
  // idem pro adapter do Kiro (watcher de ~/.kiro/sessions/cli/)
  hookInstaller.syncKiroIfInstalled(path.join(__dirname, 'adapters/kiro/ai-traffic-lights.js'), BASE_DIR);
  settingsCfg = loadSettings();                      // threshold/atalho/idioma do usuário
  applyLang();                                       // Preferências (lang) > locale do sistema
  createWindow();
  // Watcher do Kiro DEPOIS da janela: o bootstrap() dele é síncrono (readdir +
  // stat + leitura do tail de cada sessão viva) e antes do createWindow atrasava
  // o overlay aparecer, em benefício de nada — o watcher não precisa preceder a UI.
  // O watcher do Kiro exige as DUAS coisas: o Kiro existir na máquina E o adapter
  // ter sido instalado (a cópia em BASE_DIR). Antes bastava a primeira, e por isso
  // "Remover hooks" não desligava nada — o watcher voltava no próximo launch, sem
  // opt-out nenhum (achado 11 do review da PR #46). De quebra, a cópia deixa de
  // ser peso morto: ela É o marcador de "o usuário optou por isto", igual ao
  // plugin do OpenCode.
  if (hookInstaller.kiroAvailable() && hookInstaller.kiroInstalled(BASE_DIR)) {
    kiroAdapter.start(chokidar, () => collect.invalidateDiscovery());
  } else if (hookInstaller.kiroAvailable()) {
    _kiroPrecisaInstalar = true;   // avisado depois, quando notifyUser existir
  }
  applyShortcut();                                   // usa settingsCfg.shortcut (+ legado)
  if (collect.backfillModels()) sendSessions(); // preenche model das sessões existentes de cara
  _stateWatcher = chokidar
    .watch(STATE_DIR, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 } })
    .on('all', () => sendSessions());
  reapDead();
  _sessionInterval = setInterval(() => { collect.invalidateDiscovery(); reapDead(); sendSessions(); saveBounds(); }, 5000); // descobre novos + limpa mortos + captura posição (drag externo p/ ex.)
  // Consumo/reset dos agentes: GLM (rede, cache 30s) + Codex/Antigravity (disco).
  // Cadência própria (60s) — desacoplada das sessões (que refrescam a cada 5s).
  // O Claude é LAZY: o loop de fundo NÃO bate na API dele (limite agregado do
  // 429); só o boot e os gatilhos de UI (abrir/revelar overlay, ⟳) buscam o %.
  trayIpc = require('./src/ipc/tray').setupTrayIpc({   // tray extraído (REF passo 8) — PRIMEIRO: notifyUser p/ collectAndSendUsage e os demais
    ipcMain, APP_VERSION, toggleWin, assetsDir: path.join(__dirname, 'assets'),
    buildMenu: () => buildTrayMenu(),   // compositor (main): refs launcherIpc/updateIpc resolvidas só no call (createTray)
  });
  notifyUser = trayIpc.notifyUser;   // alias p/ update/focus/launcher (recebem por DI)

  // Aviso de migração do Kiro: SÓ AQUI, porque até a linha acima `notifyUser` é
  // o no-op de main.js — chamá-lo antes engolia a notificação em silêncio, e o
  // marcador gravado antes da chamada fazia com que ela nunca mais fosse
  // tentada. Um aviso criado para impedir uma regressão silenciosa que era, ele
  // próprio, silencioso. Marca só depois que a notificação de fato saiu.
  if (_kiroPrecisaInstalar) {
    try {
      const marca = path.join(BASE_DIR, '.kiro-aviso-instalar');
      if (!fs.existsSync(marca)) {
        notifyUser(T('ntf_kiro_needs_install'));
        fs.mkdirSync(BASE_DIR, { recursive: true });
        fs.writeFileSync(marca, String(Date.now()));
      }
    } catch {}
  }
  collectAndSendUsage({ claudeFetch: true });    // boot: 1 chamada p/ já ter o % (notifyUser já resolvido)
  _usageInterval = setInterval(collectAndSendUsage, 60 * 1000);   // fundo: claudeFetch=false (não bate)
  updateIpc = require('./src/ipc/update').setupUpdateIpc({   // auto-update extraído (REF passo 1)
    getMainWindow: () => win, getSettings: () => settingsCfg,
    T, revealIfHidden, REPO_URL, APP_VERSION, AUTOSTART_FILE,
  });
  require('./src/ipc/aliases').setupAliasesIpc({   // aliases extraído (REF passo 7)
    ipcMain, ALIASES_FILE, sendSessions,
    onAliasSaved: (key, alias) => {   // atualiza o título da aba Terminal (alias é o nome da aba)
      for (const [id, s] of termSessions) {
        if (s.sessionKey === key) {
          const t = termTabTitle({ alias, label: s.label, cwd: s.cwd, tmux_session: s.tmux_session, origin: s.origin, isLocal: s.kind === 'local' });
          s.title = t; sendTerm('term-tab-title', { tabId: id, title: t });
        }
      }
    },
  });
  require('./src/ipc/account-labels').setupAccountLabelsIpc({   // multi-conta #58
    ipcMain, ACCOUNT_LABELS_FILE,
    getLastAccountIds: () => lastAccountIds,
    recollect: () => collectAndSendUsage({ claudeFetch: false }),
  });
  require('./src/ipc/focus').setupFocusIpc({   // focus extraído (REF passo 4)
    ipcMain, getProcessEnviron, notifyUser, T, IS_WAYLAND,
  });
  launcherIpc = require('./src/ipc/launcher').setupLauncherIpc({   // launcher extraído (REF passo 5)
    ipcMain, getSettings: () => settingsCfg, notifyUser, T, scanPathBin, hasBin, lastSessionCwd,
    ensureTermWin, addTermSession, spawnPtyLocal,
  });
  settingsIpc = require('./src/ipc/settings').setupSettingsIpc({   // settings extraído (REF passo 9) — antes do createTray (tray referencia createSettingsWindow)
    ipcMain, getSettings: () => settingsCfg, getLang: () => LANG, T, APP_VERSION, REPO_URL,
    SETTINGS_BOUNDS_FILE, BASE_DIR, appDir: __dirname, SETTINGS_W, SETTINGS_H,
  });
  trayIpc.createTray();   // DEPOIS de launcherIpc/updateIpc/settingsIpc: buildTrayMenu os referencia
  applySync();                                   // sync P2P: sobe servidor/poller se habilitado
});

// Referências para cleanup no encerramento.
let _stateWatcher = null;
let _sessionInterval = null;
let _usageInterval = null;

app.on('window-all-closed', () => app.quit());
// macOS: re-abrir ao clicar no ícone do app (faz sentido no dev run — no build
// empacotado o LSUIElement remove o ícone do Dock; aqui é reveal, não toggle).
app.on('activate', () => { if (win && !win.isDestroyed()) revealIfHidden(); });
app.on('will-quit', () => {
  for (const id of [...termSessions.keys()]) destroyTermSession(id);
  globalShortcut.unregisterAll();
  if (_sessionInterval) clearInterval(_sessionInterval);
  if (_usageInterval) clearInterval(_usageInterval);
  if (_stateWatcher) _stateWatcher.close().catch(() => {});
  kiroAdapter.stop();
});

// ---- consumo/reset dos agentes (Claude via ~/.claude.json, GLM via API) ----
// Coletor async (GLM faz rede → nunca bloqueia o ciclo de 5s das sessões).
// Em caso de erro, mantém o último usage válido (não pisca a UI a cada falha).
//
// Persistência: o último uso conhecido é gravado em usage.json e recarregado no
// boot — sobrevive a reinício. As linhas voltam com o fetchedAt antigo, então o
// mergeUsage já as marca stale (cinza) na hora; ou refrescam (viram cor viva) ou
// somem após USAGE_DROP_MS. Nunca mostra número velho como se fosse atual.
// Seguro em disco: o objeto de uso é só {plan,%,reset,...} — NÃO contém tokens.
function loadUsage() {
  try {
    const arr = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    // descarta o que já passou do teto de drop (não ressuscita lixo antigo).
    const now = Date.now();
    return arr.filter((e) => e && e.id && (now - (e.fetchedAt || 0)) < usage.USAGE_DROP_MS)
      .map((e) => ({ ...e, stale: true })); // entra sempre como stale até refrescar
  } catch { return []; }
}
let usageSaveTimer = null;
function saveUsage() {
  clearTimeout(usageSaveTimer);
  usageSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(USAGE_FILE, JSON.stringify(lastUsage)); } catch { /* ignore */ }
  }, 300);
}
let lastUsage = loadUsage();

// Cooldown do 429 da API de uso do Claude, PERSISTIDO em disco (com o contador
// de falhas p/ o backoff exponencial). Sem isto, rodar em dev (`bun start`/
// restarts) perde o estado a cada reinício, re-bate no boot e RE-ESCALA o rate
// limit. Grava só {until, fails} por conta — NUNCA o token. Nunca lança.
function saveClaudeCooldown(key, { until, fails } = {}) {
  if (!key) return;
  claudeCooldowns[key] = { until: until || 0, fails: fails || 0 };
  // só entries vigentes no disco — arquivo não cresce com contas mortas
  const live = {};
  for (const [k, v] of Object.entries(claudeCooldowns)) {
    if (v && v.until > Date.now()) live[k] = v;
  }
  try { fs.writeFileSync(CLAUDE_COOLDOWN_FILE, JSON.stringify(live)); } catch { /* ignore */ }
}
// Formato: { "<accountKey>": { until, fails } } — cooldown POR CONTA (429 de
// uma conta não silencia as outras). Aceita o legado { until, fails } raiz
// (global) como entrada 'default' p/ não perder a janela vigente no upgrade.
function loadClaudeCooldown() {
  let o;
  try { o = JSON.parse(fs.readFileSync(CLAUDE_COOLDOWN_FILE, 'utf8')); } catch { return {}; }
  if (!o || typeof o !== 'object') return {};
  if (typeof o.until === 'number' && o.until > Date.now()) {
    return { default: { until: o.until, fails: (typeof o.fails === 'number' && o.fails > 0) ? o.fails : 0 } };
  }
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v.until === 'number' && v.until > Date.now()) {
      out[k] = { until: v.until, fails: (typeof v.fails === 'number' && v.fails > 0) ? v.fails : 0 };
    }
  }
  return out;
}
const claudeCooldowns = loadClaudeCooldown();
// p/ a UI (tooltip do ⟳): o MAIOR cooldown vigente entre as contas
function activeCooldownMeta() {
  let best = { until: 0, fails: 0 };
  for (const c of Object.values(claudeCooldowns)) {
    if (c && c.until > Date.now() && c.until > best.until) best = c;
  }
  return best;
}

// Credenciais do GLM vivem no AMBIENTE DE CADA TERMINAL (o usuário tem terminais
// Claude/Anthropic e terminais Claude/GLM — z.ai), possivelmente com CONTAS
// z.ai DIFERENTES em terminais diferentes. Não estão em dotfile nem globais.
// Estratégia: varrer TODAS as sessões vivas cujo modelo é GLM e ler
// ANTHROPIC_BASE_URL/AUTH_TOKEN do /proc/<pid>/environ de cada uma. Dedup por
// token (mesma conta em N terminais → 1 bloco). Cada credencial distinta vira
// uma entrada; collectUsage busca o consumo de cada uma com a credencial dela.
// Zero token em disco. Nenhuma sessão GLM → lista vazia → faixa só com Claude.
function crypto_() { return require('crypto'); }
function glmCredsFromSessions() {
  let sessions = [];
  try { sessions = readSessions(); } catch { return []; }
  const byToken = new Map(); // token → { env, label, suffix }
  for (const s of sessions) {
    // Só sessão LOCAL: o pid de sessão remota é processo no PEER — probeá-lo
    // no /proc daqui pode colidir com um processo local sem relação que tenha
    // as envs GLM e fabricar credencial fantasma (review fix #7).
    if (!isLocalSession(s) || !s.pid || !/^glm/i.test(s.model || '')) continue;
    let env;
    try {
      const raw = getProcessEnviron(s.pid);
      env = usage.parseEnviron(raw, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
    } catch { continue; } // processo morreu entre readSessions e a leitura
    if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
    const token = env.ANTHROPIC_AUTH_TOKEN;
    if (byToken.has(token)) continue;      // mesma conta já coletada
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = String(byToken.size + 1); }
    // rótulo da conta = host do endpoint (z.ai / bigmodel) — distingue provedores
    let label = '';
    try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch { /* base inválida */ }
    byToken.set(token, { env, label, suffix });
  }
  return [...byToken.values()];
}

// FALLBACK: o processo PRINCIPAL do Claude Code às vezes não herda as env vars
// do GLM no environ (lançado via wrapper/alias que não repassa), mas seus
// SUBPROCESSOS sim (MCP servers, shells filhos, etc.). Se glmCredsFromSessions
// não achou nada nos pids das sessões, varre todo o sistema procurando qualquer
// processo com ANTHROPIC_BASE_URL (z.ai/bigmodel) + token. A conta é uma só —
// qualquer processo que tenha as credenciais serve pra buscar o % do plano.
// Dedup por token. Nunca lança; só lê o que o dono consegue (EACCES → skip).
function glmCredsFromProc() {
  const byToken = new Map();
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ps', ['-ax', '-E', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const content = m[2];
        const rawEnv = parseMacOSEnviron(content);
        const env = usage.parseEnviron(rawEnv, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
        if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
        if (!/api\.z\.ai|bigmodel\.cn/.test(env.ANTHROPIC_BASE_URL)) continue;
        const token = env.ANTHROPIC_AUTH_TOKEN;
        if (byToken.has(token)) continue;
        let suffix;
        try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
        catch { suffix = String(byToken.size + 1); }
        let label = '';
        try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch {}
        byToken.set(token, { env, label, suffix });
        if (byToken.size >= 2) break;
      }
    } catch { return []; }
  } else {
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(n => parseInt(n, 10)); } catch { return []; }
    for (const pid of pids) {
      let raw;
      try { raw = getProcessEnviron(pid); } catch { continue; }
      const env = usage.parseEnviron(raw, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
      if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
      if (!/api\.z\.ai|bigmodel\.cn/.test(env.ANTHROPIC_BASE_URL)) continue;
      const token = env.ANTHROPIC_AUTH_TOKEN;
      if (byToken.has(token)) continue;
      let suffix;
      try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
      catch { suffix = String(byToken.size + 1); }
      let label = '';
      try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch {}
      byToken.set(token, { env, label, suffix });
      if (byToken.size >= 2) break;
    }
  }
  return [...byToken.values()];
}

// OpenCode guarda as credenciais dos providers em auth.json. Se houver o
// provider z.ai (zai-coding-plan), sua API key consulta a MESMA API de quota do
// GLM (/api/monitor/usage/quota/limit) → reaproveita readGlmUsage. Assim o uso
// do OpenCode-via-z.ai aparece na faixa mesmo sem sessão GLM viva no /proc.
// Zero token exposto além do que já está no auth.json local.
function opencodeGlmCreds() {
  const authFile = path.join(DATA_HOME, 'opencode', 'auth.json');
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return []; }
  const out = [];
  // provider zai-coding-plan (z.ai) — { type:'api', key:'...' }
  const zai = auth['zai-coding-plan'];
  if (zai && zai.type === 'api' && zai.key) {
    const token = zai.key;
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = 'oc'; }
    out.push({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: token },
      label: 'z.ai', suffix,
    });
  }
  return out;
}

// OpenCode Go: usa o provedor 'opencode-go' para consultar a API nativa
function opencodeApiCreds() {
  const authFile = path.join(DATA_HOME, 'opencode', 'auth.json');
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return null; }

  const ocg = auth['opencode-go'];
  if (ocg && ocg.type === 'api' && ocg.key) {
    const token = ocg.key;
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = 'oc'; }
    return {
      env: { OPENCODE_AUTH_TOKEN: token },
      label: 'OpenCode Go', suffix,
    };
  }
  return null;
}

// Mescla duas listas de credenciais GLM, deduplicando pelo token (uma conta
// z.ai aberta no terminal E no OpenCode não deve virar 2 blocos iguais).
function mergeGlmCreds(a, b) {
  const byToken = new Map();
  for (const c of [...(a || []), ...(b || [])]) {
    const tok = c && c.env && c.env.ANTHROPIC_AUTH_TOKEN;
    if (tok && !byToken.has(tok)) byToken.set(tok, c);
  }
  return [...byToken.values()];
}

function getProcessCwd(pid) {
  if (!pid) return null;
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1000 });
      for (const line of output.split('\n')) {
        if (line.startsWith('n')) {
          return line.slice(1).trim();
        }
      }
    } catch {}
    return null;
  } else {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
}

// Codex é passivo: o uso vive no rollout da sessão, associado por cwd. As
// sessões Codex vivas são detectadas por /proc (sem state file próprio) e o
// cwd é lido de /proc/<pid>/cwd no Linux ou via lsof no macOS. Dedup por cwd.
function codexCwdsFromSessions() {
  let sessions = [];
  try { sessions = readSessions(); } catch { return []; }
  const cwds = new Set();
  for (const s of sessions) {
    // Só sessão LOCAL (review fix #7): pid do peer no /proc local é fantasma.
    if (!isLocalSession(s) || !s.pid || agentOf(s) !== 'codex') continue;
    try {
      const cwd = getProcessCwd(s.pid);
      if (cwd) cwds.add(cwd);
    } catch { /* processo morreu ou sem permissão */ }
  }
  return [...cwds];
}

// ---- multi-conta Claude (#58): uma barra por conta com sessão viva ----
// Perfis nomeados (dd-claude) lançam o claude com CLAUDE_CONFIG_DIR no environ
// do processo; sessões SEM a var são da conta default (~/.claude → symlink do
// perfil ativo). Descoberta = varrer o environ dos pids claude vivos (mesmo
// padrão do glmCredsFromSessions), dedup por REALPATH do dir — o dedup fino
// por identidade (accountUuid) acontece no collectUsage. A default entra
// sempre (a barra nunca some) e primeiro. Labels manuais de account-labels.json
// são aplicados aqui por uuid; lastAccountIds (sfx→uuid) deixa o IPC de rename
// resolver a chave a partir do accountId que o renderer manda.
let lastAccountIds = {}; // accountId (sfx da barra) → accountUuid|dir da conta
function claudeAccountsFromSessions() {
  let sessionsList = [];
  try { sessionsList = readSessions(); } catch { return [{ dir: null }]; }
  const seenReal = new Set();
  const named = [];
  // realpath do config dir default (~/.claude pode ser symlink dd-claude).
  // SEMPRE o ~/.claude do home: configDir() puro honraria o CLAUDE_CONFIG_DIR
  // do AMBIENTE DO ATL — se o app foi lançado de dentro de uma sessão de
  // perfil (npm start num terminal dd-claude), a "default" viraria o perfil
  // do shell, a conta real dele seria descartada como "default disfarçada" e
  // o ~/.claude entraria como named. A default das SESSÕES é o symlink.
  let defReal = null;
  try { defReal = fs.realpathSync(claudePaths.configDir({ home: app.getPath('home') })); } catch {}
  let hasDefault = false;
  for (const s of sessionsList) {
    // Só sessão LOCAL (review fix #7): o pid de sessão remota é processo no
    // PEER; probeá-lo no /proc daqui pode colidir com processo local sem
    // relação e criar conta fantasma (ou marcar a default errada).
    if (!isLocalSession(s) || !s.pid || agentOf(s) !== 'claude') continue;
    let env;
    try { env = usage.parseEnviron(getProcessEnviron(s.pid), ['CLAUDE_CONFIG_DIR']); }
    catch { continue; } // processo morreu entre readSessions e a leitura
    const d = env.CLAUDE_CONFIG_DIR;
    if (d) {
      let real;
      try {
        if (!fs.statSync(d).isDirectory()) continue;
        real = fs.realpathSync(d);
      } catch { continue; }
      if (defReal && real === defReal) { hasDefault = true; continue; } // é a default disfarçada
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      named.push({ dir: d });
    } else {
      hasDefault = true; // claude puro → conta do symlink default
    }
  }
  // A default entra quando tem sessão viva (sem a var, ou var apontando pro
  // próprio ~/.claude) OU quando NÃO há nenhuma conta descoberta — a barra
  // sempre existe. Só-sessões-named → só as named (conta default não está em uso).
  const accounts = (hasDefault || !named.length) ? [{ dir: null }, ...named] : named;
  // Apelidos manuais (#58): chave = accountUuid (fallback dir) — mesmo source
  // do sfx, então o rótulo sobrevive à troca de nome do perfil no disco.
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(ACCOUNT_LABELS_FILE, 'utf8')) || {}; } catch {}
  lastAccountIds = {};
  for (const a of accounts) {
    // home injetado = conta do symlink ~/.claude, não a var ambiente do ATL
    const pc = usage.readClaudeConfig({ home: app.getPath('home'), dir: a.dir });
    if (!pc) continue;
    // Chave de identidade: ORG primeiro (limite/billing por org — #60),
    // accountUuid só p/ contas pessoais. Fallback labels[accountUuid]:
    // apelido gravado antes da chave de org continuar funcionando.
    const key = (pc.accountOrgUuid || pc.accountUuid) || a.dir || 'default';
    const sfx = usage.claudeAccountSfx(key);
    lastAccountIds[sfx] = key;
    const manual = labels[key] || (pc.accountUuid && labels[pc.accountUuid]);
    if (manual) a.label = manual;
  }
  return accounts;
}

async function collectAndSendUsage({ claudeFetch = false } = {}) {
  try {
    let glmCreds = glmCredsFromSessions();
    // Fallback 1: o próprio app foi lançado de um terminal GLM (vars já no env).
    if (!glmCreds.length && process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
      glmCreds = [{ env: process.env }];
    }
    // Fallback 2: o processo principal do Claude Code às vezes não herda as
    // vars, mas subprocessos sim. Varre o /proc inteiro procurando qualquer
    // processo com credenciais z.ai (a conta é uma só). Resolve o bug do GLM
    // "parar de atualizar" quando nenhuma sessão-monitorada tem as vars no environ.
    if (!glmCreds.length) glmCreds = glmCredsFromProc();
    // OpenCode: se tiver o provider z.ai (zai-coding-plan) no auth.json, a
    // credencial dele consulta a MESMA API de quota — mescla (dedup por token).
    glmCreds = mergeGlmCreds(glmCreds, opencodeGlmCreds());

    // OpenCode Go: consulta a API nativa do OpenCode
    const ocCred = opencodeApiCreds();

    const codexCwds = codexCwdsFromSessions();
    const claudeAccounts = claudeAccountsFromSessions();   // multi-conta #58
    const entries = await usage.collectUsage({
      glmCreds, codexCwds, home: app.getPath('home'), claudeAccounts,
      opencodeEnv: ocCred ? ocCred.env : undefined,
      opencodeLabel: ocCred ? ocCred.label : undefined,
      opencodeSuffix: ocCred ? ocCred.suffix : undefined,
      // LAZY: o loop de fundo (claudeFetch=false) NÃO bate na API do Claude — só
      // os gatilhos de UI (abrir/revelar overlay, ⟳) e o boot passam true. Tira o
      // app do limite agregado do 429 (compartilhado com o /status do Claude Code).
      claudeAllowFetch: claudeFetch,
      // cooldown do 429 persistido POR CONTA: não rebate na API enquanto vigente;
      // o coletor chama de volta claudeSetCooldown(key, {until, fails}) quando
      // leva um 429 novo (grava só a entrada daquela conta).
      claudeCooldowns,
      claudeSetCooldown: saveClaudeCooldown,
    });
    // Funde com o último estado: mantém o valor bom de cada linha se a coleta
    // atual falhou pra ela (evita zerar/sumir); esmaece pra cinza (stale) após
    // alguns min sem atualização em vez de piscar. Ver usage.mergeUsage.
    if (Array.isArray(entries)) { lastUsage = usage.mergeUsage(lastUsage, entries); saveUsage(); maybeNotifyReset(); }
  } catch { /* collectUsage já engole erros internamente; defeção dupla */ }
  sendToRenderer('usage', lastUsage);
  // meta p/ a UI: o cooldown do 429 (se vigente) alimenta o tooltip do botão ⟳.
  const _cdMeta = activeCooldownMeta();
  sendToRenderer('usage-meta', { claudeCooldownUntil: _cdMeta.until, claudeCooldownFails: _cdMeta.fails });
}

// Estado (por id) que detectReset usa entre coletas p/ achar a transição
// "estava esgotado → resetou". Vive só na memória do processo: se o app estava
// fechado no horário do reset, não há estado prévio → não notifica retroativo
// (proposital — o usuário já vê a barra liberada ao reabrir).
let resetNotifyState = {};
// Após cada coleta, vê se algum limite ESGOTADO acabou de resetar e — se o
// usuário deixou ligado (settings.notifyOnReset) — dispara uma notificação
// nativa COM som (silent:false; é um evento que o usuário estava esperando).
// Nunca lança: a detecção de reset não pode derrubar o loop de uso.
function maybeNotifyReset() {
  try {
    if (settingsCfg.notifyOnReset === false) { resetNotifyState = {}; return; }
    const threshold = typeof settingsCfg.resetNotifyThresholdPct === 'number' ? settingsCfg.resetNotifyThresholdPct : 90;
    const { toNotify, nextState } = usage.detectReset(resetNotifyState, lastUsage, Date.now(), threshold);
    resetNotifyState = nextState;
    for (const e of toNotify) {
      const name = [e.plan, e.title].filter(Boolean).join(' · ') || e.id;
      try { new Notification({ title: 'AI Traffic Lights', body: T('ntf_tokens_reset', { name }), silent: false }).show(); } catch {}
    }
    if (toNotify.length && settingsCfg.revealOnReset) revealIfHidden(); // traz à frente se oculto
  } catch { /* detecção de reset nunca derruba a coleta */ }
}
ipcMain.on('request-usage', () => {
  sendToRenderer('usage', lastUsage);
  const _cdMeta = activeCooldownMeta();
  sendToRenderer('usage-meta', { claudeCooldownUntil: _cdMeta.until, claudeCooldownFails: _cdMeta.fails });
});

// Force (botão ⟳): fura o cache de CONVENIÊNCIA (5min Claude / 30s GLM) e
// recoleta na hora. NÃO fura o cooldown do 429 — esse vive no disco e é injetado
// em collectUsage, então mesmo com o cache limpo o coletor não re-bate durante a
// janela de rate limit (evita re-escalar). É "atualizar já", não "ignorar limite".
ipcMain.on('force-usage', () => {
  try {
    // Durante cooldown ativo NÃO limpa o cache do Claude: ele guarda o último
    // valor bom que readClaudeUsage usa como fallback. Limpá-lo faria o tile
    // regredir p/ plano-só (perder o %) só porque o usuário clicou ⟳ no rate
    // limit. Fora do cooldown, limpa normalmente p/ forçar recoleta real.
    if (!activeCooldownMeta().until) usage._clearClaudeCache();
    usage._clearGlmCache();
    usage._clearCodexCache();
  } catch { /* ignore */ }
  collectAndSendUsage({ claudeFetch: true });   // ⟳: gatilho de UI → busca o % agora
});
// ---- auto-update: extraído para src/ipc/update.js (REF passo 1) ----
