const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell, Tray } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const net = require('net')

const http = require('http')

const APP_NAME = 'RAGSystem'
const APP_ID = 'com.ragsystem.desktop' // 与 electron-builder appId 一致；Windows 通知以 AUMID 归属应用
const PREFERRED_PORT = Number(process.env.RAGSYSTEM_BACKEND_PORT || 5002)
const MAX_PORT_SEARCH = 20
const START_TIMEOUT_MS = 45000
const isDev = !app.isPackaged
const isSmoke = process.env.RAGSYSTEM_DESKTOP_SMOKE === '1'
// 开发时前端走 Vite dev server（HMR）；设置后主窗口/宠物窗口加载该地址而非后端静态产物
const devFrontendUrl = process.env.RAGSYSTEM_DEV_FRONTEND_URL?.trim() || null
const APP_ICON = path.join(__dirname, 'build', 'icon.ico')

// Windows 通知归属（AUMID）：必须在 app ready 前设置，否则 toast 无法正确关联应用。
// 未打包的 dev 模式还需一枚带 AUMID 的开始菜单快捷方式，否则 toast 静默不显示
// （安装包由 electron-builder 建快捷方式；dev 在此自建，幂等覆盖）。
function ensureWindowsToastIdentity() {
  if (process.platform !== 'win32') return
  app.setAppUserModelId(APP_ID)
  if (app.isPackaged) return
  const shortcutPath = path.join(
    app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`,
  )
  try {
    shell.writeShortcutLink(shortcutPath, {
      target: process.execPath,
      args: path.join(__dirname),
      appUserModelId: APP_ID,
      description: APP_NAME,
    })
  } catch (error) {
    console.warn('dev toast 快捷方式创建失败（通知可能不显示）:', error.message)
  }
}
ensureWindowsToastIdentity()

// 主窗口标题栏：Windows 隐藏原生标题栏（titleBarStyle:'hidden'），最小化/最大化/关闭
// 由前端自绘（frontend-client/src/components/WindowControls.vue），尺寸与 hover 和
// 应用内图标按钮同语言；拖拽区由各顶栏的 app-region:drag 提供。
// 已知取舍：自绘按钮没有 Win11 贴靠布局悬浮面板（Win+方向键/贴边拖拽吸附不受影响）。

let mainWindow = null
let backendProcess = null
let actualPort = PREFERRED_PORT
let tray = null
const petWindows = []

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

// 桌宠窗口点击穿透切换：interactive=true 时宠物可交互，false 时鼠标事件直达下层窗口
// 【已移除】全屏覆盖 + setIgnoreMouseEvents 翻转方案在 Windows 上会让光标在系统箭头与
// 页面光标间高频跳变（electron#48035 家族）。桌宠窗口改为"跟随宠物本体的小包围盒"：
// 窗口即宠物矩形，永远可交互、不再穿透/转发，闪烁机制从根上消除；位置由渲染进程
// 经 pet:set-bounds 驱动（漫游/拖拽/缩放都走这条 IPC）。
ipcMain.handle('pet:set-bounds', (event, bounds) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || !bounds) return false
  // 防御性钳制：渲染进程的坏数据（旧缓存比例等）不至于把窗口丢出屏幕
  const area = screen.getDisplayMatching({
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Number(bounds.width) || 1,
    height: Number(bounds.height) || 1,
  }).workArea
  const width = Math.min(Math.max(Number(bounds.width) || 480, 120), 1400)
  const height = Math.min(Math.max(Number(bounds.height) || 300, 100), 1200)
  const x = Math.min(Math.max(Number(bounds.x) || area.x, area.x - 40), area.x + area.width - width + 40)
  const y = Math.min(Math.max(Number(bounds.y) || area.y, area.y - 40), area.y + area.height - height + 40)
  win.setBounds({ x, y, width, height })
  return true
})

// 拖拽需要屏幕绝对坐标：小窗口跟随鼠标移动时 clientX 会随窗口原点漂移，不可用
ipcMain.handle('pet:cursor-pos', () => {
  const point = screen.getCursorScreenPoint()
  return { x: point.x, y: point.y }
})

// 宠物窗口默认不抢焦点（focusable:false）；快速输入框打开时临时可聚焦收键盘
ipcMain.handle('pet:set-focus', (event, focus) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  win.setFocusable(Boolean(focus))
  if (focus) win.focus()
  return true
})

// 快速对话：把宠物窗口输入的文本送主窗口聊天输入框并前置主窗口
ipcMain.handle('pet:quick-ask', (event, text) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('ragsystem:quick-ask', String(text ?? '').slice(0, 2000))
  return true
})

// 系统通知：任务完成/失败/需要确认且主窗口失焦时弹出 OS 通知（事件引擎在 pet 插件，
// 宠物本体不承载任务提示——纯桌宠）。主窗口可见且持焦点 = 用户在看，勿扰。
// 实例保持引用直至关闭，防止被 GC 导致 toast 消失/回调失效。
const activeNotifications = new Set()
ipcMain.handle('desktop:notify', (event, payload) => {
  if (!Notification.isSupported()) return false
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) return false
  const title = String(payload?.title ?? '').slice(0, 120)
  if (!title) return false
  const body = String(payload?.body ?? '').slice(0, 200)
  const notification = new Notification({ title, body: body || undefined })
  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  notification.on('close', () => activeNotifications.delete(notification))
  activeNotifications.add(notification)
  notification.show()
  return true
})

// 自绘窗口控件的窗口操作；最大化状态变化经事件推回渲染进程切换图标
ipcMain.handle('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.handle('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.handle('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
ipcMain.handle('window:is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return Boolean(win && !win.isDestroyed() && win.isMaximized())
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
    const backendRoot = path.join(__dirname, 'dist', 'backend-local')
    return {
      command: process.execPath,
      args: [path.join(backendRoot, 'main.mjs')],
      cwd: backendRoot,
      frontendDist: path.join(__dirname, '..', 'frontend-client', 'dist'),
    }
  }

  const resourcesDir = process.resourcesPath
  const backendRoot = path.join(resourcesDir, 'backend-local')
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

  // 桌面端使用独立数据目录：backend-local 硬性要求 deployment/execution=local，
  // 而 ~/.ragsystem 可能被 SaaS/远程档位的开发数据占用（system_settings 会覆盖 env）。
  // 仍可用 RAG_DATA_ROOT 环境变量显式覆盖。
  const runtimeRoot = process.env.RAG_DATA_ROOT || path.join(os.homedir(), '.ragsystem-desktop')
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
    BACKEND_PLUGIN_CONFIG: path.join(backend.cwd, 'backend.plugins.yaml'),
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
      if (isSmoke) {
        failSmoke(new Error(`backend exited: code=${code ?? 'null'} signal=${signal ?? 'null'}; logs=${logsDir}`))
        return
      }
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
    backgroundColor: '#161616', // 启动首帧底色（默认暗色主题）
    // Windows：隐藏原生标题栏，窗口控件由前端自绘（WindowControls.vue）
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!isSmoke) mainWindow.show()
  })

  // 自绘最大化/还原按钮的图标状态同步（双击拖拽区、贴边吸附等系统途径同样覆盖）
  const sendMaximizedChanged = (isMaximized) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', isMaximized)
    }
  }
  mainWindow.on('maximize', () => sendMaximizedChanged(true))
  mainWindow.on('unmaximize', () => sendMaximizedChanged(false))

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

  mainWindow.loadURL(devFrontendUrl || `http://127.0.0.1:${actualPort}`)
}

// 桌宠窗口：透明无边框置顶，每个显示器一个（宠物在各自屏幕内渲染与漫游）。
// 窗口是"跟随宠物本体的小包围盒"而非整屏覆盖：永远可交互（无穿透/转发切换），
// 几何由渲染进程按虚拟显示器坐标经 pet:set-bounds 驱动；初始大小/位置只是占位，
// 页面加载后会按位置记忆与场景缩放立即校正。display 工作区随 URL 传给页面，
// 供其把视口比例位置换算成屏幕坐标（多显示器分键记忆同理）。
function createPetWindow(display, displayIndex) {
  const workArea = display.workArea
  const petWindow = new BrowserWindow({
    x: workArea.x + workArea.width - 520,
    y: workArea.y + workArea.height - 420,
    width: 500,
    height: 320,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 未聚焦窗口中动画不被节流
    },
  })
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.once('ready-to-show', () => petWindow.show())
  petWindow.on('closed', () => {
    const index = petWindows.indexOf(petWindow)
    if (index >= 0) petWindows.splice(index, 1)
  })
  const query = `display=${displayIndex}&standalone=1`
    + `&dx=${workArea.x}&dy=${workArea.y}&dw=${workArea.width}&dh=${workArea.height}`
  petWindow.loadURL(`${devFrontendUrl || `http://127.0.0.1:${actualPort}`}/pet?${query}`)
  petWindows.push(petWindow)
  return petWindow
}

function createPetWindows() {
  const displays = screen.getAllDisplays()
  displays.forEach((display, index) => createPetWindow(display, index))
}

function petWindowsVisible() {
  return petWindows.some((win) => win.isVisible())
}

function togglePetWindows() {
  const show = !petWindowsVisible()
  if (show) {
    // Windows 上透明 + focusable:false 窗口 hide()/show() 后鼠标输入管线失效（Electron 已知问题，
    // setBounds 自触碰/focusable 翻转/setIgnoreMouseEvents 重设实测均无法完全恢复）：
    // 显示时销毁重建，走与首次创建一致的路径；位置由页面 localStorage 记忆，原位重现。
    for (const win of [...petWindows]) win.destroy()
    createPetWindows()
  } else {
    for (const win of [...petWindows]) win.hide()
  }
  if (tray && !tray.isDestroyed()) rebuildTrayMenu()
}

/** 托盘菜单需按宠物可见性/自启状态重建（label 在构建时固化，toggle 后不重建会显示过期文案）。 */
function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: petWindowsVisible() ? '隐藏桌宠' : '显示桌宠', click: togglePetWindows },
    {
      label: '打开主窗口',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createMainWindow()
        }
      },
    },
    { type: 'separator' },
    {
      // 不用 type:'checkbox'：Windows 原生菜单会为勾选符号在整列左侧预留空白栏，
      // 未勾选时左侧一列全空、所有条目右移，观感突兀；状态改写入 label。
      label: `开机自启：${app.getLoginItemSettings().openAtLogin ? '已开启' : '已关闭'}`,
      click: () => {
        app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin })
        rebuildTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true
        app.quit()
      },
    },
  ]))
}

function createTray() {
  tray = new Tray(APP_ICON)
  tray.setToolTip(APP_NAME)
  tray.on('click', togglePetWindows)
  rebuildTrayMenu()
}

async function bootstrap() {
  try {
    await startBackend()
    createMainWindow()
    createTray()
    // 桌宠默认开启；RAGSYSTEM_DESKTOP_PET=0 关闭。smoke 模式跳过（不影响断言）。
    if (!isSmoke && process.env.RAGSYSTEM_DESKTOP_PET !== '0') {
      createPetWindows()
    }
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
  if (tray) {
    tray.destroy()
    tray = null
  }
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
