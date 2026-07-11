const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ragsystemDesktop', {
  platform: process.platform,
  selectProjectFolder: () => ipcRenderer.invoke('dialog:select-project-folder'),
})
