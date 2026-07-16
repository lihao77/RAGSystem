const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const net = require('net')

const http = require('http')

const APP_NAME = 'RAGSystem'
const PREFERRED_PORT = Number(process.env.RAGSYSTEM_BACKEND_PORT || 5002)
const MAX_PORT_SEARCH = 20
const START_TIMEOUT_MS = 45000
const isDev = !app.isPackaged
const isSmoke = process.env.RAGSYSTEM_DESKTOP_SMOKE === '1'
const APP_ICON = path.join(__dirname, 'build', 'icon.ico')

let mainWindow = null
let backendProcess = null
let actualPort = PREFERRED_PORT

ipcMain.handle('dialog:select-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择项目文件夹',
  })
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, path: null }
  }
  return { canceled: false, path: result.filePaths[0] }
})

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.connect(port, '127.0.0.1')
  })
}

async function isRAGSystemBackend(port) {
  try {
    const ready = await getJson(`http://127.0.0.1:${port}/readyz`, 2000)
    return ready?.status === 'ready' && ready?.service === 'ragsystem-backend'
  } catch {
    return false
  }
}

async function findFreePort(preferred) {
  for (let offset = 0; offset < MAX_PORT_SEARCH; offset++) {
    const candidate = preferred + offset
    if (!(await isPortInUse(candidate))) return candidate
  }
  throw new Error(`端口 ${preferred}-${preferred + MAX_PORT_SEARCH - 1} 均被占用`)
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()

    const tryConnect = () => {
      const socket = new net.Socket()
      socket.setTimeout(1500)

      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('timeout', () => { socket.destroy(); retryOrFail() })
      socket.once('error', () => { socket.destroy(); retryOrFail() })

      socket.connect(port, '127.0.0.1')
    }

    const retryOrFail = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Backend did not start on port ${port} within ${timeoutMs}ms`))
        return
      }
      setTimeout(tryConnect, 500)
    }

    tryConnect()
  })
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function resolveBackendCommand() {
  if (isDev) {
    const backendRoot = path.join(__dirname, 'dist', 'backend-ts')
    return {
      command: process.execPath,
      args: [path.join(backendRoot, 'main.mjs')],
      cwd: backendRoot,
      frontendDist: path.join(__dirname, '..', 'frontend-client', 'dist'),
    }
  }

  const resourcesDir = process.resourcesPath
  const backendRoot = path.join(resourcesDir, 'backend-ts')
  return {
    command: process.execPath,
    args: [path.join(backendRoot, 'main.mjs')],
    cwd: backendRoot,
    frontendDist: path.join(resourcesDir, 'frontend-dist'),
  }
}

async function startBackend() {
  // 检测默认端口是否已有 RAGSystem 后端在运行（终端调试实例）
  if (await isPortInUse(PREFERRED_PORT)) {
    if (await isRAGSystemBackend(PREFERRED_PORT)) {
      console.log(`端口 ${PREFERRED_PORT} 已有 RAGSystem 后端运行，直接复用`)
      actualPort = PREFERRED_PORT
      return // 不启动新进程，直接复用
    }
    // 端口被其他程序占用，寻找空闲端口
    actualPort = await findFreePort(PREFERRED_PORT + 1)
    console.log(`端口 ${PREFERRED_PORT} 被占用，后端将使用端口 ${actualPort}`)
  } else {
    actualPort = PREFERRED_PORT
  }

  const runtimeRoot = process.env.RAG_DATA_ROOT || path.join(os.homedir(), '.ragsystem')
  const logsDir = path.join(runtimeRoot, 'logs')
  ensureDir(logsDir)

  const stdoutLog = fs.openSync(path.join(logsDir, 'backend.stdout.log'), 'a')
  const stderrLog = fs.openSync(path.join(logsDir, 'backend.stderr.log'), 'a')

  const backend = resolveBackendCommand()
  if (!fs.existsSync(backend.args[0])) {
    throw new Error(`TypeScript 后端产物不存在：${backend.args[0]}。请先运行 npm run build:backend`)
  }
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BACKEND_TS_HOST: '127.0.0.1',
    BACKEND_TS_PORT: String(actualPort),
    PORT: String(actualPort),
    NODE_ENV: 'production',
    FRONTEND_DIST: backend.frontendDist,
    RAG_DATA_ROOT: runtimeRoot,
  }

  backendProcess = spawn(backend.command, backend.args, {
    cwd: runtimeRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', stdoutLog, stderrLog],
  })

  backendProcess.once('exit', (code, signal) => {
    backendProcess = null
    if (!app.isQuitting) {
      dialog.showErrorBox(
        APP_NAME,
        `后端进程已退出。\ncode=${code ?? 'null'} signal=${signal ?? 'null'}\n请查看日志：${logsDir}`,
      )
      app.quit()
    }
  })

  return waitForPort(actualPort, START_TIMEOUT_MS)
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSmoke) mainWindow.show()
  })

  if (isSmoke) {
    mainWindow.webContents.on('console-message', (details) => {
      console.error(`RAGSYSTEM_DESKTOP_RENDERER_CONSOLE level=${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})`)
    })
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error(`RAGSYSTEM_DESKTOP_RENDERER_GONE ${JSON.stringify(details)}`)
    })
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const page = await waitForRendererReady(mainWindow.webContents, 15000)
        const readiness = await getJson(`http://127.0.0.1:${actualPort}/readyz`, 3000)
        if (page.textLength === 0 || page.rootChildren === 0 || readiness?.status !== 'ready' || readiness?.service !== 'ragsystem-backend') {
          throw new Error(`invalid renderer state: ${JSON.stringify({ page, readiness })}`)
        }
        console.log(`RAGSYSTEM_DESKTOP_SMOKE_OK ${JSON.stringify({ port: actualPort, url: mainWindow.webContents.getURL(), page })}`)
        finishSmoke(0)
      } catch (error) {
        failSmoke(error)
      }
    })
    mainWindow.webContents.once('did-fail-load', (_event, code, description, url) => {
      failSmoke(new Error(`renderer failed to load: code=${code} description=${description} url=${url}`))
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(`http://127.0.0.1:${actualPort}`)
}

async function bootstrap() {
  try {
    await startBackend()
    createMainWindow()
  } catch (error) {
    if (isSmoke) {
      failSmoke(error)
      return
    }
    dialog.showErrorBox(APP_NAME, `启动失败：\n${error.message}`)
    app.quit()
  }
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('health request timed out')))
    request.on('error', reject)
  })
}

async function waitForRendererReady(webContents, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let page = null
  while (Date.now() < deadline) {
    page = await webContents.executeJavaScript(`({
      title: document.title,
      textLength: document.body?.innerText?.trim().length || 0,
      rootChildren: document.querySelector('#app')?.childElementCount || 0
    })`)
    if (page.textLength > 0 && page.rootChildren > 0) return page
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`renderer did not mount within ${timeoutMs}ms: ${JSON.stringify(page)}`)
}

function failSmoke(error) {
  console.error(`RAGSYSTEM_DESKTOP_SMOKE_FAILED ${error instanceof Error ? error.stack || error.message : String(error)}`)
  finishSmoke(1)
}

function finishSmoke(code) {
  app.isQuitting = true
  process.exitCode = code
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
  if (backendProcess && !backendProcess.killed) backendProcess.kill()
  backendProcess = null
  setTimeout(() => process.exit(code), 100)
}

app.on('before-quit', () => {
  app.isQuitting = true
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill()
  }
})

app.whenReady().then(bootstrap)

app.on('window-all-closed', () => {
  if (isSmoke) return
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})
