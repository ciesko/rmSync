const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings:  ()      => ipcRenderer.invoke('get-settings'),
  saveSettings: (s)     => ipcRenderer.invoke('save-settings', s),
  syncNotes:    ()      => ipcRenderer.invoke('sync-notes'),
  getNotes:     ()      => ipcRenderer.invoke('get-notes'),
  getPages:     (uuid)  => ipcRenderer.invoke('get-pages', uuid),
  getPageImage: (p)     => ipcRenderer.invoke('get-page-image', p),
  getPageStrokes: (p)   => ipcRenderer.invoke('get-page-strokes', p),
  pickFolder:   ()      => ipcRenderer.invoke('pick-folder'),
  onSyncProgress: (cb)  => ipcRenderer.on('sync-progress', (_, d) => cb(d)),
});
