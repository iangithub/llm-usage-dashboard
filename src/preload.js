'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  onUpdate: (cb) => {
    const handler = (_e, model) => cb(model);
    ipcRenderer.on('usage:update', handler);
    return () => ipcRenderer.removeListener('usage:update', handler);
  },
  getAutostart: () => ipcRenderer.invoke('app:autostart-get'),
  setAutostart: (on) => ipcRenderer.invoke('app:autostart-set', on),
  onAutostartChanged: (cb) => {
    const handler = (_e, on) => cb(on);
    ipcRenderer.on('autostart:changed', handler);
    return () => ipcRenderer.removeListener('autostart:changed', handler);
  },
});
