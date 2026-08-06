import assert from "node:assert/strict";
import test from "node:test";

import { RunSandboxManager } from "../dist/run-sandbox-manager.js";

test("run sandbox runtime reuses one owner-bound lease and collects outputs before destroy", async () => {
  const events = [];
  const execInputs = [];
  let creates = 0;
  const driver = {
    async create(input) {
      creates += 1;
      events.push("create");
      return { id: "lease-1", owner: input.owner, createdAt: "now" };
    },
    async exec(_lease, input) {
      execInputs.push(input);
      return { stdout: "ok", stderr: "", returnCode: 0, interrupted: false };
    },
    async destroy() { events.push("destroy"); },
  };
  const lifecycle = {
    async prepare() { events.push("prepare"); },
    async collectOutputs() { events.push("collect"); },
  };
  const runtime = new RunSandboxManager("tenant-1", driver, 60, lifecycle);
  const controller = new AbortController();
  const context = {
    userId: "user-1",
    sessionId: "session-1",
    runId: "run-1",
    signal: controller.signal,
    attachmentFileIds: ["attachment-1"],
  };

  await runtime.exec(context, { command: "pwd", cwd: "/work", timeoutSeconds: 5 });
  await runtime.exec(context, { command: "ls", cwd: "/work", timeoutSeconds: 5 });

  assert.equal(creates, 1);
  assert.equal(execInputs.length, 2);
  assert.equal(execInputs[0].signal, controller.signal);
  assert.deepEqual(events, ["create", "prepare"]);

  await runtime.releaseRun("session-1", "run-1");
  assert.deepEqual(events, ["create", "prepare", "collect", "destroy"]);
});

test("run sandbox runtime skips output collection when a run is cancelled", async () => {
  const events = [];
  const driver = {
    async create(input) { return { id: "lease-1", owner: input.owner, createdAt: "now" }; },
    async exec() { return { stdout: "ok", stderr: "", returnCode: 0, interrupted: false }; },
    async destroy() { events.push("destroy"); },
  };
  const lifecycle = {
    async prepare() {},
    async collectOutputs() { events.push("collect"); },
  };
  const runtime = new RunSandboxManager("tenant-1", driver, 60, lifecycle);
  const context = { userId: "user-1", sessionId: "session-1", runId: "run-1" };
  await runtime.exec(context, { command: "pwd", cwd: "/work", timeoutSeconds: 5 });

  await runtime.releaseRun("session-1", "run-1", { collectOutputs: false });

  assert.deepEqual(events, ["destroy"]);
});

test("abort cleanup remains awaitable by the terminal run hook", async () => {
  const controller = new AbortController();
  let finishDestroy;
  const destroyGate = new Promise((resolve) => { finishDestroy = resolve; });
  const driver = {
    async create(input) { return { id: "lease-1", owner: input.owner, createdAt: "now" }; },
    async exec() { return { stdout: "ok", stderr: "", returnCode: 0, interrupted: false }; },
    async destroy() { await destroyGate; },
  };
  const runtime = new RunSandboxManager("tenant-1", driver, 60);
  const context = { userId: "user-1", sessionId: "session-1", runId: "run-1", signal: controller.signal };
  await runtime.exec(context, { command: "pwd", cwd: "/work", timeoutSeconds: 5 });

  controller.abort();
  let released = false;
  const releasePromise = runtime.releaseRun("session-1", "run-1", { collectOutputs: false })
    .then(() => { released = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false);

  finishDestroy();
  await releasePromise;
  assert.equal(released, true);
});

test("prepare failure reports a failed destroy instead of swallowing it", async () => {
  const prepareError = new Error("prepare failed");
  const destroyError = new Error("destroy failed");
  const driver = {
    async create(input) { return { id: "lease-1", owner: input.owner, createdAt: "now" }; },
    async destroy() { throw destroyError; },
  };
  const runtime = new RunSandboxManager("tenant-1", driver, 60, {
    async prepare() { throw prepareError; },
  });

  await assert.rejects(
    runtime.exec(
      { userId: "user-1", sessionId: "session-1", runId: "run-1" },
      { command: "pwd", cwd: "/work", timeoutSeconds: 5 },
    ),
    (error) => error instanceof AggregateError
      && error.errors.includes(prepareError)
      && error.errors.includes(destroyError),
  );
});

test("run sandbox runtime close waits for lease destruction", async () => {
  let finishDestroy;
  const destroyGate = new Promise((resolve) => { finishDestroy = resolve; });
  const driver = {
    async create(input) { return { id: "lease-1", owner: input.owner, createdAt: "now" }; },
    async exec() { return { stdout: "ok", stderr: "", returnCode: 0, interrupted: false }; },
    async destroy() { await destroyGate; },
  };
  const runtime = new RunSandboxManager("tenant-1", driver, 60);
  await runtime.exec(
    { userId: "user-1", sessionId: "session-1", runId: "run-1" },
    { command: "pwd", cwd: "/work", timeoutSeconds: 5 },
  );

  let closed = false;
  const closePromise = runtime.closeAll().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  finishDestroy();
  await closePromise;
  assert.equal(closed, true);
});
