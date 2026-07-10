import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-desktop-smoke-"));
const port = await getFreePort();
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...baseEnv } = process.env;

const child = spawn(electronPath, ["."], {
  cwd: desktopRoot,
  env: {
    ...baseEnv,
    RAGSYSTEM_DESKTOP_SMOKE: "1",
    RAGSYSTEM_BACKEND_PORT: String(port),
    RAG_DATA_ROOT: runtimeRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
  process.stderr.write(chunk);
});

const timeout = setTimeout(() => {
  child.kill();
}, 60_000);

try {
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  if (code !== 0 || !stdout.includes("RAGSYSTEM_DESKTOP_SMOKE_OK")) {
    throw new Error(`Desktop smoke failed: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const marker = stdout.split(/\r?\n/).find((line) => line.includes("RAGSYSTEM_DESKTOP_SMOKE_OK"));
  console.log(marker?.trim());
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
  fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selected = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (selected === null) reject(new Error("Unable to allocate desktop smoke port"));
        else resolve(selected);
      });
    });
  });
}
