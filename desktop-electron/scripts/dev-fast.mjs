// 轻量桌面开发启动：不打包、全源码热迭代。
//   前端：Vite dev server（HMR，端口 5174，/api 代理到后端）
//   后端：backend-local 源码 tsx watch（插件经 --conditions=development 直接走 src）
//   壳：Electron 复用已就绪的后端（与正式启动一致的复用策略），窗口加载 Vite 地址
// 数据目录与桌面正式启动一致（默认 ~/.ragsystem-desktop），装一次向导两边共用。
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");

// 显式设置 RAG_DATA_ROOT 且默认端口被占时会换空闲端口（见下方 try 内），故用 let
let backendPort = Number(process.env.RAGSYSTEM_BACKEND_PORT || 5002);
let vitePort = Number(process.env.VITE_DEV_PORT || 5174);
let backendUrl = `http://127.0.0.1:${backendPort}`;
let viteUrl = `http://127.0.0.1:${vitePort}`;
const desktopDataRoot = process.env.RAG_DATA_ROOT || path.join(os.homedir(), ".ragsystem-desktop");

const children = [];
let shuttingDown = false;
// 本进程拉起的 backend/vite 端口；复用已运行实例时保持 null（不归我们清理）。
let spawnedBackendPort = null;
let spawnedVitePort = null;

// Windows 下 shell:true 的 kill 只杀 cmd 壳，孙进程会残留；taskkill /T 杀整棵进程树
const killTree = (child) => {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
};

// 端口兜底：windowsHide 的子进程不接控制台事件（收不到 Ctrl+C），外层 npm 与本进程的
// 清理也存在竞速——树杀落空时按监听端口反查 PID 补杀，否则后端/Vite 会逐次残留累积。
const killListenersOnPort = async (port) => {
  if (process.platform !== "win32" || !port) return;
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { windowsHide: true });
    const pids = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /\s\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[1]) === port) {
        const pid = Number(match[2]);
        if (pid && pid !== process.pid) pids.add(pid);
      }
    }
    if (pids.size === 0) return;
    await Promise.all(
      [...pids].map((pid) =>
        execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {})),
    );
    console.log(`[dev-fast] 端口 ${port} 兜底清理了 ${pids.size} 个残留监听进程`);
  } catch {
    // netstat/taskkill 不可用等环境问题：树杀已尽力，静默跳过
  }
};

const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  void (async () => {
    await killListenersOnPort(spawnedBackendPort);
    await killListenersOnPort(spawnedVitePort);
    setTimeout(() => process.exit(code), 500);
  })();
};
// 用 on 而非 once：清理期间用户再按 Ctrl+C 不应触发默认硬杀、打断兜底清理
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

const getJson = (url, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });

const waitUntil = async (check, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待超时：${label}`);
};

const isRagBackend = async () => {
  try {
    const readiness = await getJson(`${backendUrl}/readyz`);
    return readiness?.status === "ready" && readiness?.service === "ragsystem-backend";
  } catch {
    return false;
  }
};

const isViteUp = async () => {
  try {
    await new Promise((resolve, reject) => {
      const request = http.get(`${viteUrl}/`, { timeout: 2000 }, (response) => {
        response.resume();
        response.on("end", resolve);
      });
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", reject);
    });
    return true;
  } catch {
    return false;
  }
};

const isPortOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.Socket();
    socket.setTimeout(800);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, "127.0.0.1");
  });

const freePortFrom = async (base) => {
  for (let port = base; port < base + 20; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`端口 ${base}-${base + 19} 均被占用`);
};

const forward = (prefix) => (chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) process.stdout.write(`[${prefix}] ${line}\n`);
  }
};

// vite 的 exports 未暴露 ./bin/vite.js，从包目录直接探测
const resolveViteBin = () => {
  try {
    const viteRoot = path.dirname(require.resolve("vite/package.json"));
    const candidate = path.join(viteRoot, "bin", "vite.js");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // exports 同样未暴露 package.json 时，退回 node_modules 目录探测
  }
  for (const base of [repoRoot, path.join(repoRoot, "frontend-client")]) {
    const candidate = path.join(base, "node_modules", "vite", "bin", "vite.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 vite/bin/vite.js（请先在仓库根执行 npm install）");
};

try {
  // 1) 后端：无显式数据目录且已有 ragsystem 后端时复用；否则源码 watch 启动。
  //    显式设置 RAG_DATA_ROOT 时绝不复用（复用的后端数据目录不受本地设置影响），
  //    另起空闲端口，Vite 也随之换端口（代理目标变了）。
  let reuseBackend = await isRagBackend();
  if (reuseBackend && process.env.RAG_DATA_ROOT) {
    console.warn(
      `[dev-fast] 端口 ${backendPort} 已有后端，但 RAG_DATA_ROOT 已显式设置——不复用，` +
        `将另起端口使用数据目录 ${desktopDataRoot}`,
    );
    reuseBackend = false;
    backendPort = await freePortFrom(backendPort + 1);
    vitePort = await freePortFrom(vitePort + 1);
    backendUrl = `http://127.0.0.1:${backendPort}`;
    viteUrl = `http://127.0.0.1:${vitePort}`;
  }
  if (reuseBackend) {
    console.log(`[dev-fast] 复用已运行的后端 ${backendUrl}（数据目录由该后端决定，本地 RAG_DATA_ROOT 不生效）`);
  } else {
    const backend = spawn("npm", ["run", "dev:backend-local"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BACKEND_TS_HOST: "127.0.0.1",
        BACKEND_TS_PORT: String(backendPort),
        PORT: String(backendPort),
        RAG_DATA_ROOT: desktopDataRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    });
    children.push(backend);
    spawnedBackendPort = backendPort;
    backend.stdout.on("data", forward("backend"));
    backend.stderr.on("data", forward("backend"));
    backend.once("exit", (code) => {
      if (!shuttingDown) {
        console.error(`[dev-fast] 后端进程退出（code=${code}），查看上方 [backend] 日志`);
        shutdown(code ?? 1);
      }
    });
  }
  await waitUntil(isRagBackend, 60_000, `后端就绪 ${backendUrl}/readyz`);

  // 2) 前端：已在运行的 Vite dev server 复用，否则启动（strictPort，端口冲突快速失败）
  if (!(await isViteUp())) {
    const viteBin = resolveViteBin();
    const vite = spawn(process.execPath, [viteBin, "--port", String(vitePort), "--strictPort"], {
      cwd: path.join(repoRoot, "frontend-client"),
      env: {
        ...process.env,
        VITE_DEV_PORT: String(vitePort),
        VITE_API_PROXY_TARGET: backendUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(vite);
    spawnedVitePort = vitePort;
    vite.stdout.on("data", forward("vite"));
    vite.stderr.on("data", forward("vite"));
  } else {
    console.log(`[dev-fast] 复用已运行的 Vite ${viteUrl}`);
  }
  await waitUntil(isViteUp, 30_000, `Vite 就绪 ${viteUrl}`);

  // 3) Electron：复用后端（RAGSYSTEM_BACKEND_PORT 命中 main.js 的复用逻辑），窗口加载 Vite
  console.log(`[dev-fast] 启动 Electron：前端 ${viteUrl}，后端 ${backendUrl}，数据 ${desktopDataRoot}`);
  // RAGSYSTEM_ELECTRON_ARGS：透传额外启动参数（如 --remote-debugging-port=9222）
  const electronArgs = ["."];
  for (const arg of process.env.RAGSYSTEM_ELECTRON_ARGS?.split(" ").filter(Boolean) ?? []) electronArgs.push(arg);
  const electronApp = spawn(electronPath, electronArgs, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      RAGSYSTEM_BACKEND_PORT: String(backendPort),
      RAGSYSTEM_DEV_FRONTEND_URL: viteUrl,
      RAG_DATA_ROOT: desktopDataRoot,
    },
    stdio: "inherit",
  });
  electronApp.once("exit", (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(`[dev-fast] 启动失败：${error.message}`);
  shutdown(1);
}
