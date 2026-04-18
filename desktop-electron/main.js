const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const net = require('net')

const APP_NAME = 'RAGSystem'
const DEFAULT_PORT = Number(process.env.RAGSYSTEM_BACKEND_PORT || 5001)
const START_TIMEOUT_MS = 45000
const isDev = !app.isPackaged

let mainWindow = null
let backendProcess = null

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()

    const tryConnect = () => {
      const socket = new net.Socket()
      socket.setTimeout(1500)

      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('timeout', () => {
        socket.destroy()
        retryOrFail()
      })
      socket.once('error', () => {
        socket.destroy()
        retryOrFail()
      })

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
    return {
      command: process.env.RAGSYSTEM_PYTHON || 'python',
      args: [path.join(__dirname, '..', 'backend-fastapi', 'desktop_entry.py')],
      cwd: path.join(__dirname, '..', 'backend-fastapi'),
      frontendDist: path.join(__dirname, '..', 'frontend-client', 'dist'),
    }
  }

  const resourcesDir = process.resourcesPath
  const backendRoot = path.join(resourcesDir, 'backend', 'RAGSystemBackend')
  const executable = path.join(backendRoot, 'RAGSystemBackend.exe')
  return {
    command: executable,
    args: [],
    cwd: backendRoot,
    frontendDist: path.join(resourcesDir, 'frontend-dist'),
  }
}

function startBackend() {
  const runtimeRoot = path.join(os.homedir(), '.ragsystem')
  const logsDir = path.join(runtimeRoot, 'logs')
  ensureDir(logsDir)

  const stdoutLog = fs.openSync(path.join(logsDir, 'backend.stdout.log'), 'a')
  const stderrLog = fs.openSync(path.join(logsDir, 'backend.stderr.log'), 'a')

  const backend = resolveBackendCommand()
  const env = {
    ...process.env,
    FASTAPI_HOST: '127.0.0.1',
    FASTAPI_PORT: String(DEFAULT_PORT),
    PORT: String(DEFAULT_PORT),
    FASTAPI_RELOAD: 'false',
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

  return waitForPort(DEFAULT_PORT, START_TIMEOUT_MS)
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(`http://127.0.0.1:${DEFAULT_PORT}`)
}

async function bootstrap() {
  try {
    await startBackend()
    createMainWindow()
  } catch (error) {
    dialog.showErrorBox(APP_NAME, `启动失败：\n${error.message}`)
    app.quit()
  }
}

app.on('before-quit', () => {
  app.isQuitting = true
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill()
  }
})

app.whenReady().then(bootstrap)

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})
