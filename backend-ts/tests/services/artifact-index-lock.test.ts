import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const STALE_MS = 2_000;
const UPDATE_MS = 1_000;
const CHILD_PATH = fileURLToPath(new URL("../fixtures/artifact-index-lock-child.ts", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-index-lock-"));
  roots.push(root);
  return root;
}

function spawnLockHolder(root: string): ChildProcess {
  const child = fork(CHILD_PATH, [root, String(STALE_MS), String(UPDATE_MS)], {
    execArgv: ["--import", "tsx"],
    silent: true,
  });
  children.add(child);
  return child;
}

function waitForMessage(child: ChildProcess, expected: unknown, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${JSON.stringify(expected)}`)), timeoutMs);
    const onExit = (code: number | null) => finish(new Error(`lock child exited with code ${code}`));
    const onMessage = (message: unknown) => {
      if (JSON.stringify(message) === JSON.stringify(expected)) finish();
      else if (typeof message === "object" && message !== null && "error" in message) finish(new Error(String(message.error)));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error); else resolve();
    };
    child.on("exit", onExit);
    child.on("message", onMessage);
  });
}

function expectNoMessage(child: ChildProcess, unexpected: unknown, durationMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (JSON.stringify(message) === JSON.stringify(unexpected)) finish(new Error(`unexpected message ${JSON.stringify(message)}`));
    };
    const timeout = setTimeout(() => finish(), durationMs);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      if (error) reject(error); else resolve();
    };
    child.on("message", onMessage);
  });
}

describe("artifact index cross-process lock", () => {
  it("keeps a heartbeat lease exclusive past its stale threshold and admits the waiter after release", async () => {
    const root = makeRoot();
    const first = spawnLockHolder(root);
    await waitForMessage(first, "entered");

    await new Promise((resolve) => setTimeout(resolve, STALE_MS + 500));
    const second = spawnLockHolder(root);
    await expectNoMessage(second, "entered", 500);

    first.send("release");
    await waitForMessage(first, "released");
    await waitForMessage(second, "entered");
    second.send("release");
    await waitForMessage(second, "released");
  });

  it("recovers after a crashed holder leaves a stale lock", async () => {
    const root = makeRoot();
    const crashed = spawnLockHolder(root);
    await waitForMessage(crashed, "entered");
    crashed.kill("SIGKILL");

    const recovered = spawnLockHolder(root);
    await waitForMessage(recovered, "entered");
    recovered.send("release");
    await waitForMessage(recovered, "released");
  });

  it("does not let a compromised old holder release a later holder's lock", async () => {
    const root = makeRoot();
    const oldHolder = spawnLockHolder(root);
    await waitForMessage(oldHolder, "entered");
    oldHolder.send("block");
    await waitForMessage(oldHolder, "blocking");

    await new Promise((resolve) => setTimeout(resolve, STALE_MS + 500));
    const newHolder = spawnLockHolder(root);
    await waitForMessage(newHolder, "entered");
    await waitForMessage(oldHolder, "block-complete");
    oldHolder.send("release");

    const waiter = spawnLockHolder(root);
    await expectNoMessage(waiter, "entered", 500);
    newHolder.send("release");
    await waitForMessage(newHolder, "released");
    await waitForMessage(waiter, "entered");
    waiter.send("release");
    await waitForMessage(waiter, "released");
  }, 20_000);
});
