import fs from "node:fs";
import http from "node:http";
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
const backendRoot = path.join(desktopRoot, "dist", "backend-local");
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-electron-probe-"));
const port = await getFreePort();

const child = spawn(electronPath, [path.join(backendRoot, "main.mjs")], {
  cwd: backendRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    BACKEND_TS_HOST: "127.0.0.1",
    BACKEND_TS_PORT: String(port),
    RAG_DATA_ROOT: runtimeRoot,
    FRONTEND_DIST: path.join(desktopRoot, "..", "frontend-client", "dist"),
    BACKEND_PLUGIN_CONFIG: path.join(backendRoot, "backend.plugins.yaml"),
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  const readiness = await waitForReadiness();
  if (readiness?.status !== "ready" || readiness?.service !== "ragsystem-backend") {
    throw new Error(`Unexpected readiness response: ${JSON.stringify(readiness)}`);
  }
  console.log(`Electron backend probe passed (Electron Node, node:sqlite, sqlite-vec) on ${port}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function waitForReadiness() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited with ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    try {
      return await getJson(`http://127.0.0.1:${port}/readyz`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Backend probe timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 1000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("Unable to allocate probe port"));
        else resolve(port);
      });
    });
  });
}
