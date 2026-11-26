'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, explicit bridge. The renderer is the same web UI that runs on a
 * phone, so it stays sandboxed: only these four calls cross into Node.
 */
contextBridge.exposeInMainWorld('sentinelDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('sentinel:info'),
  setAutoStart: (enabled) => ipcRenderer.invoke('sentinel:set-auto-start', enabled),
  openExternal: (url) => ipcRenderer.invoke('sentinel:open-external', url),
  quit: () => ipcRenderer.invoke('sentinel:quit'),
});
