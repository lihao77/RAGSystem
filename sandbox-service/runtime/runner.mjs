import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const kind = process.argv[2];

try {
  const input = await readInput();
  const result = await execute(kind, input);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function execute(executionKind, input) {
  const timeoutSeconds = requireInteger(input.timeoutSeconds, "timeoutSeconds", 1, 600);
  const cwd = await requireCwd(input.cwd);
  const source = executionKind === "bash"
    ? requireString(input.command, "command")
    : requireString(input.code, "code");
  if (source.length > 1024 * 1024) throw new Error("Sandbox command or code is too large");
  const executable = executionKind === "bash" ? "/bin/bash" : "/usr/bin/python3";
  const args = executionKind === "bash" ? ["-lc", source] : ["-c", source];
  const maxBytes = 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/work",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        SESSION_WORKSPACE_DIR: "/work",
        SESSION_UPLOADS_DIR: "/input/uploads",
        SESSION_ARTIFACTS_DIR: "/input/artifacts",
        SESSION_TRANSIENT_DIR: "/work/transient",
        RAGSYSTEM_WORKSPACE_DIR: "/work",
        RAGSYSTEM_UPLOADS_DIR: "/input/uploads",
        RAGSYSTEM_ARTIFACTS_DIR: "/input/artifacts",
        RAGSYSTEM_TRANSIENT_DIR: "/work/transient",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let interrupted = false;
    const append = (target, chunk, current) => {
      if (current >= maxBytes) {
        truncated = true;
        return current;
      }
      const accepted = chunk.subarray(0, Math.max(0, maxBytes - current));
      target.push(accepted);
      if (accepted.byteLength < chunk.byteLength) truncated = true;
      return current + accepted.byteLength;
    };
    child.stdout.on("data", (chunk) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk) => { stderrBytes = append(stderr, chunk, stderrBytes); });
    child.on("error", reject);
    const killProcessGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => {
      interrupted = true;
      killProcessGroup();
    }, timeoutSeconds * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A shell can exit after detaching children with redirected stdio. Always
      // reap the whole execution process group before returning the result.
      killProcessGroup();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const result = {
        stdout: stdoutText,
        stderr: stderrText,
        returnCode: interrupted ? 124 : (code ?? (signal ? 128 : -1)),
        interrupted,
        truncated,
      };
      resolve(executionKind === "code" ? { ...result, result: stdoutText } : result);
    });
  });
}

async function requireCwd(value) {
  const cwd = requireString(value, "cwd");
  if (!cwd.startsWith("/") || cwd.includes("\0") || cwd.split("/").includes("..")) throw new Error("Invalid sandbox cwd");
  const real = await fs.realpath(cwd);
  if (!["/input", "/work"].some((root) => real === root || real.startsWith(`${root}/`))) {
    throw new Error("Sandbox cwd is outside the allowed roots");
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error("Sandbox cwd is not a directory");
  return real;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("Sandbox runner input is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
