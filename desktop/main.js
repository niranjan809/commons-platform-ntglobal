// Commons — native desktop shell (Electron).
// Loads the real Commons web app in a native window, so every feature
// (meadow movement, chat, Slack/Zoho, notetaker, search, shortcuts) works
// natively with zero duplication. Point it at your deployed server, or at
// http://localhost:3000 for local dev via the COMMONS_URL env var.
const { app, BrowserWindow, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = process.env.COMMONS_URL || 'https://commons-platform-ntglobal-production.up.railway.app';

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function saveState(win) {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() })); } catch { /* ignore */ }
}

let mainWindow = null;

function createWindow() {
  const s = loadState();
  mainWindow = new BrowserWindow({
    width: s.width || 1320, height: s.height || 880,
    x: s.x, y: s.y, minWidth: 900, minHeight: 600,
    backgroundColor: '#182c47',
    title: 'Commons',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  if (s.maximized) mainWindow.maximize();

  const base = (() => { try { return new URL(APP_URL); } catch { return null; } })();
  const isExternal = (url) => { try { return base && new URL(url).host !== base.host; } catch { return true; } };

  // New windows / target=_blank: external hosts (Zoho meeting links, Slack deep
  // links) open in the OS browser; same-host popups (the Zoho OAuth flow, which
  // postMessages back to us) open as a child window so the handshake completes.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  // Full-page navigations of the MAIN window to an external host go to the browser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isExternal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.loadURL(APP_URL);
  for (const ev of ['resize', 'move', 'close']) mainWindow.on(ev, () => saveState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });
}

const template = [
  { label: 'Commons', submenu: [
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
    { label: 'Home', click: () => mainWindow && mainWindow.loadURL(APP_URL) },
    { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
    { type: 'separator' },
    { role: 'quit' },
  ] },
  { label: 'Edit', role: 'editMenu' },
  { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  { label: 'Window', role: 'windowMenu' },
];

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === 'win32') app.setAppUserModelId('org.ntglobal.commons');
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
