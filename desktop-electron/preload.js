const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ragsystemDesktop', {
  platform: process.platform,
  selectProjectFolder: () => ipcRenderer.invoke('dialog:select-project-folder'),
  setPetClickThrough: (interactive) => ipcRenderer.invoke('pet:set-click-through', Boolean(interactive)),
  setPetFocus: (focus) => ipcRenderer.invoke('pet:set-focus', Boolean(focus)),
  quickAsk: (text) => ipcRenderer.invoke('pet:quick-ask', text),
  onQuickAsk: (callback) => {
    ipcRenderer.on('ragsystem:quick-ask', (_event, text) => callback(text))
  },
})
