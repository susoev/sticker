const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  setNotes: (lines) => ipcRenderer.send('notes:set', lines),
  resize: (h) => ipcRenderer.send('resize', h),
  hide: () => ipcRenderer.send('hide'),
  toggleTheme: () => ipcRenderer.send('theme:toggle'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (text) => ipcRenderer.invoke('config:save', text),
  closeConfig: () => ipcRenderer.send('config:close'),
  on: (channel, cb) => {
    if (['notes', 'sync', 'active', 'config'].includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => cb(data));
    }
  },
});
