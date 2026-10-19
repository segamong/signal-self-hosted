'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('signalPicker', Object.freeze({
  getSources: () => ipcRenderer.invoke('signal:picker-sources'),
  select: (id, audio) => ipcRenderer.invoke('signal:picker-select', { id, audio: audio === true }),
  cancel: () => ipcRenderer.invoke('signal:picker-cancel'),
}));
