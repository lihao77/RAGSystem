const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('ragsystemDesktop', {
  platform: process.platform,
})
