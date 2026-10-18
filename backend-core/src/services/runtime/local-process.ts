import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import { terminateProcessTree } from "./process-tree.js";

export interface LocalProcessOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  shell?: boolean | undefined;
  /** Windows Git Bash needs its MSYS process group terminated as well as the Win32 tree. */
  msysBash?: boolean | undefined;
  maxStdoutBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
  /** Full streams are written with backpressure; only bounded previews stay in memory. */
  logDirectory?: string | undefined;
}

export interface LocalProcessResult {
  stdout: string;
  stderr: string;
  returnCode: number;
  timedOut: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutLog?: string;
  stderrLog?: string;
}

class Preview {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const remaining = Math.max(0, this.limit - this.size);
    if (chunk.length > remaining) this.truncated = true;
    if (remaining) {
      const part = Buffer.from(chunk.subarray(0, remaining));
      this.chunks.push(part);
      this.size += part.length;
    }
  }

  text(): string {
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(Buffer.concat(this.chunks, this.size));
    // A preview may end halfway through a UTF-8 character; don't emit a replacement character.
    return text + (this.truncated ? "" : decoder.end());
  }
}

/** Shared one-shot process runner for local tools; argv stays separate from shell syntax. */
export async function runLocalProcess(
  executable: string,
  args: readonly string[],
  options: LocalProcessOptions,
): Promise<LocalProcessResult> {
  if (options.signal?.aborted) throw abortError();
  const startedAt = Date.now();
  const stdout = new Preview(options.maxStdoutBytes ?? 256 * 1024);
  const stderr = new Preview(options.maxStderrBytes ?? 64 * 1024);
  const logId = randomUUID();
  if (options.logDirectory) await fs.promises.mkdir(options.logDirectory, { recursive: true });
  if (options.signal?.aborted) throw abortError();
  const stdoutLog = options.logDirectory ? path.join(options.logDirectory, `${logId}.stdout.log`) : undefined;
  const stderrLog = options.logDirectory ? path.join(options.logDirectory, `${logId}.stderr.log`) : undefined;
  const marker = process.platform === "win32" && options.msysBash ? `__RAGSYSTEM_PGID_${logId}__=` : null;
  let spawnArgs = [...args];
  if (marker) {
    const prefix = `printf '${marker}%s\\n' "$$" >&2\n`;
    spawnArgs = args[0] === "-c"
      ? ["-c", prefix + (args[1] ?? ""), ...args.slice(2)]
      : ["-c", prefix + '"$@"', "ragsystem", executable.replaceAll("\\", "/"), ...args];
  }
  const child = spawn(executable, spawnArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let processGroupId: number | null = null;
  let timedOut = false;
  let failure: Error | null = null;
  let termination: Promise<void> | undefined;
  let closed = false;
  let closeTimer: NodeJS.Timeout | undefined;
  let forceClose: () => void;
  const exit = new Promise<number>((resolve) => {
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      closed = true;
      if (closeTimer) clearTimeout(closeTimer);
      resolve(code ?? 1);
    });
    forceClose = () => {
      failure ??= new Error("Process did not close after termination");
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(1);
    };
  });
  const terminate = (): Promise<void> => {
    if (closed) return Promise.resolve();
    termination ??= (async () => {
      // Bounded fallback if a descendant keeps inherited pipe handles open after termination.
      closeTimer = setTimeout(forceClose, 5_000);
      const operations = [terminateProcessTree(child.pid, true)];
      if (marker && processGroupId !== null) operations.push(killMsysGroup(executable, processGroupId));
      // Wait for taskkill to enumerate Windows descendants before killing their parent.
      await Promise.all(operations);
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    })();
    return termination;
  };
  const abort = (): void => { void terminate(); };
  const timer = setTimeout(() => { timedOut = true; void terminate(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  let markerBuffer = Buffer.alloc(0);
  let markerPending = marker !== null;
  const capture = (preview: Preview, stripMarker: boolean): Transform => new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (stripMarker && markerPending) {
        markerBuffer = Buffer.concat([markerBuffer, chunk]);
        if (!markerBuffer.includes(10) && markerBuffer.length < 512) { callback(); return; }
        const match = markerBuffer.toString("utf8").match(new RegExp(`^${marker}(\\d+)\\r?\\n`));
        if (match) processGroupId = Number(match[1]);
        chunk = match ? markerBuffer.subarray(Buffer.byteLength(match[0])) : markerBuffer;
        markerBuffer = Buffer.alloc(0);
        markerPending = false;
      }
      preview.push(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (stripMarker && markerBuffer.length) {
        preview.push(markerBuffer);
        this.push(markerBuffer);
      }
      callback();
    },
  });
  const sink = (file?: string): Writable => file
    ? fs.createWriteStream(file, { flags: "wx" })
    : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const drain = (promise: Promise<void>): Promise<void> => promise.catch((error: Error) => {
    failure ??= error;
    return terminate();
  });
  const streams = [
    drain(pipeline(child.stdout, capture(stdout, false), sink(stdoutLog))),
    drain(pipeline(child.stderr, capture(stderr, true), sink(stderrLog))),
  ];
  try {
    const code = await exit;
    clearTimeout(timer);
    await Promise.all(streams);
    await termination;
    if (options.signal?.aborted) throw abortError();
    if (failure) throw failure;
    return {
      stdout: stdout.text(), stderr: stderr.text(), returnCode: timedOut ? 124 : code,
      timedOut, durationMs: Date.now() - startedAt,
      stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
      ...(stdoutLog ? { stdoutLog } : {}), ...(stderrLog ? { stderrLog } : {}),
    };
  } finally {
    clearTimeout(timer);
    if (closeTimer) clearTimeout(closeTimer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function abortError(): Error {
  const error = new Error("Process execution aborted");
  error.name = "AbortError";
  return error;
}

function killMsysGroup(executable: string, groupId: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn(executable, ["-c", `kill -KILL -- -${groupId}`], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { killer.kill("SIGKILL"); resolve(); }, 1_000);
    const finish = (): void => { clearTimeout(timer); resolve(); };
    killer.once("error", finish);
    killer.once("exit", finish);
  });
}
