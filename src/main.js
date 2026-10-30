const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Лог в %APPDATA%\Sticker\sticker.log — чтобы было видно, почему что-то не запустилось.
function log(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.map(a => (a && a.stack) || String(a)).join(' ')}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'sticker.log'), line);
  } catch { /* нет доступа к папке — молчим */ }
}
function fatal(err) {
  log('FATAL', err);
  try { dialog.showErrorBox('Sticker — ошибка', String((err && err.stack) || err)); } catch { /* */ }
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const { ConfigStore, validate } = require('./config');
const { NotesStore, StateStore } = require('./store');
const { Sync } = require('./sync');
const { autoUpdater } = require('electron-updater');

app.setName('Sticker');
if (process.env.STICKER_DATA) app.setPath('userData', process.env.STICKER_DATA);
app.setAppUserModelId('in.alid.sticker');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showSticker());
  app.whenReady().then(start).catch(fatal);
}
app.on('render-process-gone', (_e, _wc, d) => log('renderer gone', JSON.stringify(d)));
app.on('child-process-gone', (_e, d) => log('child gone', JSON.stringify(d)));
app.on('will-quit', () => log('quit'));

let sticker = null;
let configWin = null;
let tray = null;
let quitting = false;
let config, notes, state, sync;

const asset = (f) => path.join(__dirname, '..', 'assets', f);

function start() {
  const dir = app.getPath('userData');
  log('start', app.getVersion(), process.execPath);
  config = new ConfigStore(dir);
  notes = new NotesStore(dir);
  state = new StateStore(dir);

  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }

  createTray();
  createSticker();

  sync = new Sync({
    getConfig: () => config.data,
    notes,
    onRemote: (data) => send('notes', data),
    onStatus: (s) => send('sync', s),
  });
  sync.start();
  setupUpdates();

  if (process.env.STICKER_SHOT) require('../test/shot')({ sticker, send, openConfig, app, getConfigWin: () => configWin });
}

function send(channel, payload) {
  if (sticker && !sticker.isDestroyed()) sticker.webContents.send(channel, payload);
}

// Окно должно попадать хотя бы частично на один из мониторов, иначе ставим в правый верхний угол.
function initialBounds(width) {
  const saved = state.data.position;
  if (saved) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x + 40 > a.x && saved.x < a.x + a.width - 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40);
    if (visible) return { x: saved.x, y: saved.y };
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - width - 24, y: a.y + 24 };
}

function createSticker() {
  const width = config.data.width;
  const { x, y } = initialBounds(width);
  sticker = new BrowserWindow({
    x, y, width, height: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Sticker',
    icon: asset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  sticker.setAlwaysOnTop(true, 'floating');
  sticker.loadFile(path.join(__dirname, 'renderer', 'sticker.html'));
  // Показываем, когда страница готова; страховка — через 4 секунды показываем в любом случае.
  const reveal = () => { if (!sticker.isDestroyed() && !sticker.isVisible()) { log('show'); sticker.show(); } };
  sticker.once('ready-to-show', reveal);
  setTimeout(reveal, 4000);
  sticker.webContents.on('did-finish-load', () => log('loaded'));

  sticker.on('focus', () => send('active', true));
  sticker.on('blur', () => send('active', false));

  let moveTimer;
  sticker.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const [px, py] = sticker.getPosition();
      state.set({ position: { x: px, y: py } });
    }, 300);
  });

  // Alt+F4 прячет в трей, а не закрывает.
  sticker.on('close', (e) => {
    if (!quitting) { e.preventDefault(); sticker.hide(); }
  });
}

function showSticker() {
  if (!sticker) return;
  sticker.show();
  sticker.focus();
}

// ---- Автообновление из GitHub Releases (susoev/sticker) ----
let updateState = '';
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.logger = { info: (m) => log('upd', m), warn: (m) => log('upd warn', m), error: (m) => log('upd error', m), debug() {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => { updateState = `Скачивается ${i.version}…`; createTrayMenu(); });
  autoUpdater.on('update-not-available', () => { updateState = ''; createTrayMenu(); });
  autoUpdater.on('error', (e) => { updateState = ''; log('upd error', e); createTrayMenu(); });
  autoUpdater.on('update-downloaded', (i) => {
    log('update downloaded', i.version);
    updateState = `Обновление ${i.version} готово`;
    createTrayMenu();
    installWhenIdle();
  });
  const check = () => autoUpdater.checkForUpdates().catch((e) => log('upd check', e));
  setTimeout(check, 10 * 1000);
  setInterval(check, 60 * 60 * 1000);
}

// Перезапуск только когда стикер не в фокусе, чтобы не оборвать набор текста.
function installWhenIdle() {
  if (sticker && !sticker.isDestroyed() && sticker.isFocused()) {
    sticker.once('blur', () => setTimeout(installWhenIdle, 1500));
    return;
  }
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
}

function createTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Sticker ${app.getVersion()}`, enabled: false },
    ...(updateState ? [{ label: updateState, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Показать', click: showSticker },
    { label: 'Конфиг', click: openConfig },
    ...(app.isPackaged ? [{ label: 'Проверить обновления', click: () => autoUpdater.checkForUpdates().catch((e) => log('upd check', e)) }] : []),
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.setToolTip('Sticker');
  createTrayMenu();
  tray.on('click', showSticker);
}

function openConfig() {
  if (configWin && !configWin.isDestroyed()) { configWin.show(); configWin.focus(); return; }
  configWin = new BrowserWindow({
    width: 560, height: 640,
    title: 'Sticker — конфиг',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  configWin.setMenu(null);
  configWin.loadFile(path.join(__dirname, 'renderer', 'config.html'));
}

function applyConfig() {
  if (sticker && !sticker.isDestroyed()) {
    const [, h] = sticker.getContentSize();
    sticker.setContentSize(config.data.width, h);
  }
  send('config', config.data);
  sync.start();
}

// ---- IPC ----
ipcMain.handle('init', () => ({ config: config.data, notes: notes.data, sync: sync ? sync.status : null }));

ipcMain.on('notes:set', (_e, lines) => {
  notes.setLocal(lines);
  sync.schedulePush();
});

ipcMain.on('resize', (_e, height) => {
  if (!sticker || sticker.isDestroyed()) return;
  const display = screen.getDisplayMatching(sticker.getBounds());
  const h = Math.max(60, Math.min(Math.round(height), display.workArea.height - 20));
  sticker.setContentSize(config.data.width, h);
});

ipcMain.on('hide', () => sticker && sticker.hide());

ipcMain.on('theme:toggle', () => {
  config.set({ ...config.data, theme: config.data.theme === 'dark' ? 'light' : 'dark' });
  send('config', config.data);
});

ipcMain.handle('config:get', () => config.text());

ipcMain.handle('config:save', (_e, text) => {
  const res = validate(text);
  if (!res.ok) return res;
  config.set(res.config);
  applyConfig();
  return { ok: true, text: config.text() };
});

ipcMain.on('config:close', () => configWin && configWin.close());

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
