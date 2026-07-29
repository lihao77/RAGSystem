import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("backend-local serves health checks over an IPC socket", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-socket-start-"));
  const pluginConfigPath = path.join(dataRoot, "backend.plugins.yaml");
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\ragsystem-backend-local-${process.pid}-${randomUUID()}`
    : path.join(dataRoot, "backend.sock");
  fs.writeFileSync(pluginConfigPath, "version: 1\nplugins: []\n", "utf8");
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      BACKEND_PLUGIN_CONFIG: pluginConfigPath,
      BACKEND_TS_SOCKET_PATH: socketPath,
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
    const response = await waitForReady(child, socketPath, 10_000);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /ready|ok/i);
    assert.equal(child.exitCode, null, `backend-local exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child, 5_000);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

async function waitForReady(child, socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`backend-local exited with code ${child.exitCode}`);
    try {
      return await requestReady(socketPath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`backend-local did not listen on ${socketPath} within ${timeoutMs}ms`);
}

function requestReady(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/readyz", method: "GET", timeout: 500 }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    request.once("timeout", () => request.destroy(new Error("health check timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("backend-local did not stop")), timeoutMs)),
  ]);
}
