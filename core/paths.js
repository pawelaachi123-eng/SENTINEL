'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP_DIR_NAME = 'SENTINEL';

/**
 * Writable state lives outside the install directory so the app works
 * from a read-only location (Program Files, a mounted APK asset, CI, ...).
 */
function dataDir() {
  if (process.env.SENTINEL_HOME) return path.resolve(process.env.SENTINEL_HOME);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, APP_DIR_NAME.toLowerCase());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configFile() {
  return path.join(ensureDir(dataDir()), 'config.json');
}

function logFile() {
  return path.join(ensureDir(path.join(dataDir(), 'logs')), 'agent.log');
}

/**
 * Locate the bundled UI. Works from a plain checkout, from an Electron asar
 * and from a pkg snapshot — all of which expose a different __dirname.
 */
function uiDir() {
  const candidates = [
    process.env.SENTINEL_UI_DIR,
    path.join(__dirname, '..', 'ui'),
    path.join(__dirname, 'ui'),
    path.join(process.resourcesPath || '', 'app', 'ui'),
    path.join(process.resourcesPath || '', 'ui'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      /* ignore */
    }
  }
  return path.join(__dirname, '..', 'ui');
}

module.exports = { dataDir, ensureDir, configFile, logFile, uiDir, APP_DIR_NAME };
