const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('ragsystemDesktop', {
  platform: process.platform,
  // 只接受渲染进程中的 File；剪贴板/程序生成的 File 没有磁盘路径，返回空字符串。
  getPathForFile: (file) => webUtils.getPathForFile(file),
  selectProjectFolder: () => ipcRenderer.invoke('dialog:select-project-folder'),
  setPetClickThrough: (interactive) => ipcRenderer.invoke('pet:set-click-through', Boolean(interactive)),
  setPetFocus: (focus) => ipcRenderer.invoke('pet:set-focus', Boolean(focus)),
  quickAsk: (text) => ipcRenderer.invoke('pet:quick-ask', text),
  notify: (title, body) => ipcRenderer.invoke('desktop:notify', { title, body }),
  setTitleBarTheme: (theme) => ipcRenderer.invoke('window:set-title-bar-theme', theme),
  onQuickAsk: (callback) => {
    ipcRenderer.on('ragsystem:quick-ask', (_event, text) => callback(text))
  },
})
