'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signalDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('signal:info'),
  requestApi: (path, body) => ipcRenderer.invoke('signal:api', path, body),
  subscribeEvents: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Нужна функция обработчика.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('signal:event', listener);
    ipcRenderer.send('signal:events-ready');
    return () => ipcRenderer.removeListener('signal:event', listener);
  },
  windowAction: (action) => ipcRenderer.invoke('signal:window', action),
  getSettings: () => ipcRenderer.invoke('signal:settings-get'),
  setSettings: (settings) => ipcRenderer.invoke('signal:settings-set', settings),
  getUpdateState: () => ipcRenderer.invoke('signal:update-state'),
  checkUpdate: () => ipcRenderer.invoke('signal:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('signal:update-download'),
  installUpdate: () => ipcRenderer.invoke('signal:update-install'),
  show: () => ipcRenderer.invoke('signal:show'),
}));
