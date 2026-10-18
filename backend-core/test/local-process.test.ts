import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { runLocalProcess } from "../src/services/runtime/local-process.js";

const directories: string[] = [];
function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "local-process-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it("bounds previews by bytes while preserving full UTF-8 logs and literal argv", async () => {
  const directory = temp();
  const literal = 'space 中文 & echo nope; $(whoami) "quoted"';
  const result = await runLocalProcess(process.execPath, ["-e",
    "process.stdout.write(process.argv[1] + '\\n' + '你🙂'.repeat(100000)); process.stderr.write('错误'.repeat(100000))", literal,
  ], { timeoutMs: 10_000, logDirectory: directory, maxStdoutBytes: 101, maxStderrBytes: 103 });
  expect(result.returnCode).toBe(0);
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(true);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(101);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(103);
  expect(result.stdout).not.toContain("�");
  expect(result.stderr).not.toContain("�");
  expect(fs.readFileSync(result.stdoutLog!, "utf8")).toBe(`${literal}\n${"你🙂".repeat(100000)}`);
  expect(fs.readFileSync(result.stderrLog!, "utf8")).toBe("错误".repeat(100000));
});

it("keeps exact-limit output complete and returns nonzero exit status", async () => {
  const result = await runLocalProcess(process.execPath, ["-e", "process.stdout.write('1234'); process.exitCode=7"], {
    timeoutMs: 5_000, maxStdoutBytes: 4,
  });
  expect(result.stdout).toBe("1234");
  expect(result.stdoutTruncated).toBe(false);
  expect(result.returnCode).toBe(7);
});

it("does not start an already cancelled command", async () => {
  const target = path.join(temp(), "should-not-exist");
  const controller = new AbortController();
  controller.abort();
  await expect(runLocalProcess(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'oops')", target], {
    timeoutMs: 5_000, signal: controller.signal,
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(fs.existsSync(target)).toBe(false);
});

it("times out and keeps output emitted before termination", async () => {
  const result = await runLocalProcess(process.execPath, ["-e", "console.log('started'); setInterval(()=>{},1000)"], {
    timeoutMs: 1_000, logDirectory: temp(),
  });
  expect(result.timedOut).toBe(true);
  expect(result.returnCode).toBe(124);
  expect(result.stdout).toContain("started");
});

it("reports spawn failures without hanging or leaking log handles", async () => {
  const directory = temp();
  await expect(runLocalProcess(path.join(directory, "missing-executable"), [], {
    timeoutMs: 5_000, logDirectory: directory,
  })).rejects.toThrow();
});

it("cancellation kills the child tree before resolving", async () => {
  const directory = temp();
  const pidFile = path.join(directory, "child.pid");
  const controller = new AbortController();
  const result = runLocalProcess(process.execPath, ["-e", `
    const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    require('fs').writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);
  `, pidFile], { timeoutMs: 10_000, signal: controller.signal, logDirectory: directory });
  // Attach the rejection handler before abort, including while waiting for startup.
  const outcome = result.catch((error: Error) => error);
  try {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fs.existsSync(pidFile)).toBe(true);
  } finally {
    controller.abort();
  }
  expect(await outcome).toMatchObject({ name: "AbortError" });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
