'use strict';

/**
 * SENTINEL desktop shell.
 *
 * The Electron window is a thin frame around http://127.0.0.1:<port>, which is
 * served by the same agent that runs on the PC. That means the desktop app and
 * the phone app are literally the same UI talking to the same API — no second
 * implementation to drift out of sync.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, Notification } = require('electron');
const { createAgent } = require('../core/agent');

let mainWindow = null;
let tray = null;
let agent = null;
let quitting = false;
let setupChecked = false;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

function iconPath(file) {
  const candidates = [
    path.join(__dirname, '..', 'build', file),
    path.join(process.resourcesPath || '', 'build', file),
    path.join(app.getPath('userData'), file),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function trayImage() {
  const png = iconPath('tray.png') || iconPath('icon.png');
  if (!png) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(png);
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image.resize({ width: 20, height: 20 });
}

function buildTray() {
  try {
    tray = new Tray(trayImage());
  } catch {
    return;
  }
  const port = agent ? agent.config.get('ports.ui') : 7878;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open SENTINEL',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: agent && agent.link.status().connected ? `ESP32: ${agent.link.status().deviceId || 'linked'}` : 'ESP32: offline',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Copy phone link',
      click: async () => {
        const { clipboard } = require('electron');
        clipboard.writeText(agent ? agent.lanUrl : `http://127.0.0.1:${port}/`);
        new Notification({ title: 'SENTINEL', body: 'Phone link copied to the clipboard' }).show();
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    {
      label: 'Open control UI in browser',
      click: () => shell.openExternal(agent ? agent.loginUrl : `http://127.0.0.1:${port}/`),
    },
    { type: 'separator' },
    {
      label: 'Quit SENTINEL',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('SENTINEL — PC control');
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#060910',
    autoHideMenuBar: true,
    title: 'SENTINEL',
    icon: iconPath('icon.png') || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(agent.loginUrl);

  mainWindow.once('ready-to-show', () => {
    const hidden = process.argv.includes('--hidden');
    if (!hidden) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === 'win32' && tray) {
      tray.displayBalloon?.({ title: 'SENTINEL is still running', content: 'The agent keeps listening for your phone and ESP32.' });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerIpc() {
  ipcMain.handle('sentinel:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    loginUrl: agent ? agent.loginUrl : null,
    lanUrl: agent ? agent.lanUrl : null,
    autoStart: app.getLoginItemSettings().openAtLogin,
    esp: agent ? agent.link.status() : null,
  }));
  ipcMain.handle('sentinel:set-auto-start', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('sentinel:open-external', (_event, url) => {
    if (/^https?:/.test(url)) return shell.openExternal(url);
    return false;
  });
  ipcMain.handle('sentinel:quit', () => {
    quitting = true;
    app.quit();
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    agent = createAgent();
    agent.start();
  } catch (err) {
    dialog.showErrorBox('SENTINEL could not start', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }

  // Wait for the listener, then fail loudly instead of showing a blank window.
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (!agent.http.server || !agent.http.server.listening) {
    dialog.showErrorBox(
      'Port already in use',
      `SENTINEL could not open port ${agent.config.get('ports.ui')}.\n\n` +
        'Another copy of SENTINEL (or a headless agent) is probably already running.\n' +
        `Open http://127.0.0.1:${agent.config.get('ports.ui')}/ in your browser, or close the other instance.`,
    );
    app.quit();
    return;
  }
  setupChecked = true;

  registerIpc();
  createWindow();
  buildTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (agent) {
    try {
      agent.stop();
    } catch {
      /* ignore */
    }
  }
});

app.on('window-all-closed', () => {
  // Stay alive in the tray: the point of the app is to keep listening.
  if (process.platform !== 'darwin' && quitting) app.quit();
});

process.on('uncaughtException', (err) => {
  if (setupChecked) {
    dialog.showErrorBox('SENTINEL error', String(err && err.stack ? err.stack : err));
  }
});
