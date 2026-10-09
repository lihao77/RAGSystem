// Verify the real renderer -> preload File bridge, including files without a disk path.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ragsystem-file-path-probe-'))
  env.RAGSYSTEM_FILE_PATH_PROBE_ROOT = root
  let result
  try {
    result = spawnSync(require('electron'), [__filename], {
      env, windowsHide: true, encoding: 'utf8', timeout: 45000,
    })
  } finally {
    // Electron 必须完全退出后再清理 userData；运行中 Chromium 持有目录锁。
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const root = process.env.RAGSYSTEM_FILE_PATH_PROBE_ROOT
  assert.ok(root, 'launch the probe through Node')
  const source = path.join(root, '报告.txt')
  fs.writeFileSync(source, 'local attachment', 'utf8')
  fs.mkdirSync(path.join(root, 'user-data'))
  app.setPath('userData', path.join(root, 'user-data'))
  let win
  let exitCode = 0
  app.whenReady().then(async () => {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    await win.loadURL('data:text/html,<input type="file" id="attachment">')
    win.webContents.debugger.attach('1.3')
    const { root: document } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: document.nodeId, selector: '#attachment',
    })
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [source] })
    const result = await win.webContents.executeJavaScript(`({
      selected: window.ragsystemDesktop.getPathForFile(document.querySelector('#attachment').files[0]),
      generated: window.ragsystemDesktop.getPathForFile(new File(['hello'], 'clipboard.txt')),
    })`)
    assert.equal(result.selected, source)
    assert.equal(result.generated, '')
    console.log('Electron attachment path bridge passed: disk file path preserved; generated File has no path.')
  }).catch((error) => {
    console.error(error)
    exitCode = 1
  }).finally(() => {
    win?.destroy()
    app.exit(exitCode)
  })
}
