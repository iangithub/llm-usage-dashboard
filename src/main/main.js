'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { collectCodex } = require('./collectors/codex');
const { collectClaude } = require('./collectors/claude');
const { buildModel } = require('./aggregate');
const P = require('./paths');

let win = null;
let tray = null;
let latestModel = null;
let refreshing = false;
let pending = false;

// auto-refresh cadence (user-requested): pull a fresh snapshot every 5 minutes.
// File-watch still gives near-instant updates between ticks; each refresh re-arms
// this timer so the 5-min clock counts from the last update of any kind.
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let autoTimer = null;
let nextAutoAt = 0;
function armAuto() {
  clearTimeout(autoTimer);
  nextAutoAt = Date.now() + AUTO_REFRESH_MS;
  autoTimer = setTimeout(() => refresh('auto-5min'), AUTO_REFRESH_MS);
}

const ASSET = (f) => path.join(__dirname, '..', '..', 'assets', f);

// ---- autostart (persist desired state ourselves; OS getter is unreliable in
//      dev / with custom args, so our config file is the source of truth) -----
const AUTOSTART_NAME = 'AI Usage Dashboard';
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[config] write failed:', e); }
  return cfg;
}
function loginArgs() {
  // In dev (unpackaged) we must tell electron.exe which app to run.
  return app.isPackaged
    ? ['--hidden']
    : [path.resolve(process.argv[1] || '.'), '--hidden'];
}
function applyAutostart(on) {
  app.setLoginItemSettings({
    openAtLogin: !!on,
    path: process.execPath,
    args: loginArgs(),
    name: AUTOSTART_NAME,
  });
  writeConfig({ autostart: !!on });
  return !!on;
}
function isAutostart() {
  const cfg = readConfig();
  if (typeof cfg.autostart === 'boolean') return cfg.autostart;
  const s = app.getLoginItemSettings({ path: process.execPath, args: loginArgs() });
  return !!(s.openAtLogin || s.executableWillLaunchAtLogin);
}
// Versions <= 0.1.1 registered the login item without `name` or the app-path
// argument, leaving a Run entry named `electron.app.Electron` that launches a
// bare electron.exe (default Electron welcome window) at every boot — and the
// current toggle removes only the `AI Usage Dashboard` entry, so the stale one
// survives forever. Delete it, but only if it has that broken shape.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function cleanupStaleAutostart() {
  if (process.platform !== 'win32') return;
  const { execFile } = require('child_process');
  execFile('reg', ['query', RUN_KEY, '/v', 'electron.app.Electron'], (err, stdout) => {
    if (err) return; // value absent — nothing to clean
    if (/electron\.exe"?\s+--hidden\s*$/im.test(String(stdout))) {
      execFile('reg', ['delete', RUN_KEY, '/v', 'electron.app.Electron', '/f'], () => {});
    }
  });
}

// ---- data refresh -----------------------------------------------------------
async function refresh(reason = 'manual') {
  if (refreshing) { pending = true; return latestModel; }
  refreshing = true;
  try {
    const [codex, claude] = await Promise.all([collectCodex(), collectClaude()]);
    latestModel = buildModel({ codex, claude });
    latestModel.reason = reason;
    armAuto();
    latestModel.nextAutoRefreshAt = nextAutoAt;
    latestModel.autoRefreshMs = AUTO_REFRESH_MS;
    broadcast();
    updateTray();
  } catch (e) {
    console.error('[refresh] failed:', e);
  } finally {
    refreshing = false;
    if (pending) { pending = false; setTimeout(() => refresh('coalesced'), 50); }
  }
  return latestModel;
}

function broadcast() {
  if (win && !win.isDestroyed() && latestModel) {
    win.webContents.send('usage:update', latestModel);
  }
}

function fmtPct(n) { return (n == null) ? '—' : Math.round(n) + '%'; }

function updateTray() {
  if (!tray || !latestModel) return;
  const c = latestModel.providers.codex;
  const cl = latestModel.providers.claude;
  const p = c.rate && c.rate.primary ? c.rate.primary.used_percent : null;
  const s = c.rate && c.rate.secondary ? c.rate.secondary.used_percent : null;
  const monthCost = '$' + latestModel.totals.monthCost.toFixed(2);
  tray.setToolTip(
    `AI Usage Dashboard\n` +
    `Codex 5h: ${fmtPct(p)}  week: ${fmtPct(s)}\n` +
    `Claude (max) today: ${(cl.today.total / 1e6).toFixed(1)}M tok\n` +
    `This month est: ${monthCost}`
  );
}

// ---- file watching ----------------------------------------------------------
let debounceTimer = null;
function scheduleRefresh(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => refresh(reason), 1500);
}

function watchDir(dir, label) {
  if (!P.exists(dir)) return;
  try {
    fs.watch(dir, { recursive: true }, () => scheduleRefresh('watch:' + label));
  } catch (e) {
    console.warn('[watch] could not watch', dir, e.message);
  }
}

// ---- window + tray ----------------------------------------------------------
function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Usage Dashboard',
    icon: ASSET('icon.png'),
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    // hide to tray instead of quitting
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  let img = nativeImage.createFromPath(ASSET('tray.png'));
  if (img.isEmpty()) img = nativeImage.createFromPath(ASSET('icon.png'));
  tray = new Tray(img);
  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => createWindow() },
    { label: 'Refresh now', click: () => refresh('tray') },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: isAutostart(),
      click: (item) => {
        applyAutostart(item.checked);
        if (win && !win.isDestroyed()) win.webContents.send('autostart:changed', item.checked);
      },
    },
    { label: 'Open data folders', submenu: [
      { label: 'Codex (~/.codex/sessions)', click: () => shell.openPath(P.CODEX_SESSIONS) },
      { label: 'Claude (~/.claude/projects)', click: () => shell.openPath(P.CLAUDE_PROJECTS) },
    ] },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setToolTip('AI Usage Dashboard');
  tray.setContextMenu(menu);
  tray.on('click', () => createWindow());
  tray.on('double-click', () => createWindow());
}

// ---- IPC --------------------------------------------------------------------
ipcMain.handle('usage:get', async () => latestModel || (await refresh('ipc-get')));
ipcMain.handle('usage:refresh', async () => refresh('ipc-refresh'));
ipcMain.handle('app:autostart-get', () => isAutostart());
ipcMain.handle('app:autostart-set', (_e, on) => applyAutostart(on));

// ---- lifecycle --------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createWindow());

  app.whenReady().then(async () => {
    cleanupStaleAutostart();
    // re-assert the login item on every launch so the registered electron.exe
    // path tracks npm updates / npx cache relocation instead of going stale
    if (readConfig().autostart === true) applyAutostart(true);
    createTray();
    await refresh('startup');
    // only open the window if not launched hidden (autostart)
    const startedHidden = process.argv.includes('--hidden');
    if (!startedHidden) createWindow();

    watchDir(P.CODEX_SESSIONS, 'codex');
    watchDir(P.CLAUDE_PROJECTS, 'claude');
    // 5-min auto-refresh is armed inside refresh(); the startup refresh() above
    // already armed it. File-watch covers instant updates between ticks.

    app.on('activate', () => createWindow());
  });

  app.on('window-all-closed', () => { /* keep running in tray */ });
}
