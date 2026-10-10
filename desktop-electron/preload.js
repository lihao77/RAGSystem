const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('ragsystemDesktop', {
  platform: process.platform,
  // 只接受渲染进程中的 File；剪贴板/程序生成的 File 没有磁盘路径，返回空字符串。
  getPathForFile: (file) => webUtils.getPathForFile(file),
  selectProjectFolder: () => ipcRenderer.invoke('dialog:select-project-folder'),
  // 桌宠小包围盒窗口：渲染进程按虚拟显示器坐标驱动窗口矩形（漫游/拖拽/缩放），
  // 拖拽用屏幕绝对坐标（窗口跟随时 clientX 随原点漂移，不可用）
  setPetBounds: (bounds) => ipcRenderer.invoke('pet:set-bounds', bounds),
  getCursorScreenPos: () => ipcRenderer.invoke('pet:cursor-pos'),
  setPetFocus: (focus) => ipcRenderer.invoke('pet:set-focus', Boolean(focus)),
  quickAsk: (text) => ipcRenderer.invoke('pet:quick-ask', text),
  notify: (title, body) => ipcRenderer.invoke('desktop:notify', { title, body }),
  // 自绘窗口控件（WindowControls.vue）；无边框窗口（如桌宠）不渲染控件，不会调用
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => {
      ipcRenderer.on('window:maximized-changed', (_event, maximized) => callback(Boolean(maximized)))
    },
  },
  onQuickAsk: (callback) => {
    ipcRenderer.on('ragsystem:quick-ask', (_event, text) => callback(text))
  },
})
