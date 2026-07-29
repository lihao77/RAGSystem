import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("backend-local starts with an empty plugin config", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-zero-plugin-"));
  const pluginConfigPath = path.join(dataRoot, "backend.plugins.yaml");
  fs.writeFileSync(pluginConfigPath, "version: 1\nplugins: []\n", "utf8");
  const port = await reservePort();
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      BACKEND_PLUGIN_CONFIG: pluginConfigPath,
      BACKEND_TS_HOST: "127.0.0.1",
      BACKEND_TS_PORT: String(port),
      RAG_DATA_ROOT: dataRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForPort(child, port, 10_000);
    assert.equal(child.exitCode, null, `backend-local exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child, 5_000);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(child, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`backend-local exited with code ${child.exitCode}`);
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`backend-local did not listen on port ${port} within ${timeoutMs}ms`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("backend-local did not stop")), timeoutMs)),
  ]);
}
