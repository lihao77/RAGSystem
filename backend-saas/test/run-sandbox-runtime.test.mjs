import assert from "node:assert/strict";
import test from "node:test";

import { SaaSSandboxFileBridge } from "../dist/adapters/saas/sandbox/sandbox-file-bridge.js";
import { RunSandboxManager } from "../dist/adapters/saas/sandbox/sandbox-lease-manager.js";
import { createSaaSRuntimeContainer } from "../dist/adapters/saas/composition/saas-runtime-container.js";
import { SaaSTenantRuntimeRegistry } from "../dist/adapters/saas/composition/saas-tenant-runtime-registry.js";

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

test("SaaS tenant runtime registry fails closed without a sandbox driver", () => {
  assert.throws(
    () => new SaaSTenantRuntimeRegistry({}, undefined, {}),
    /requires a remote sandbox driver/,
  );
});

test("SaaS runtime container fails closed without a sandbox driver", async () => {
  await assert.rejects(
    createSaaSRuntimeContainer({}),
    /requires a sandbox driver/,
  );
});

test("SaaS file bridge stages session attachments and persists non-transient outputs", async () => {
  const staged = [];
  const added = [];
  const files = {
    async list(sessionId) {
      assert.equal(sessionId, "session-1");
      return [{
        id: "attachment-1",
        scope_type: "session",
        scope_id: "session-1",
        size: 3,
        stored_name: "input.txt",
        original_name: "input.txt",
        mime: "text/plain",
      }];
    },
    async read(sessionId, fileId) {
      assert.equal(sessionId, "session-1");
      assert.equal(fileId, "attachment-1");
      return { body: Buffer.from("abc"), contentType: "text/plain" };
    },
    async add(sessionId, input) {
      added.push({ sessionId, input });
      return { id: "output-1" };
    },
  };
  const driver = {
    async stageInputFile(_lease, input) {
      staged.push(input);
      return { size: Buffer.from(input.content, "base64").byteLength };
    },
    async glob() {
      return { files: ["result.txt", "transient/ignore.tmp"], truncated: false };
    },
    async readFile(_lease, input) {
      assert.equal(input.path, "/work/result.txt");
      return { content: Buffer.from("done").toString("base64"), size: 4 };
    },
  };
  const bridge = new SaaSSandboxFileBridge(files);
  const lease = { id: "lease-1", owner: {}, createdAt: "now" };
  const owner = { tenantId: "tenant-1", userId: "user-1", sessionId: "session-1", runId: "run-1" };

  await bridge.prepare(lease, owner, driver, { attachmentFileIds: ["attachment-1"] });
  assert.deepEqual(staged.map((input) => input.path), [
    "/input/uploads/input.txt",
    "/input/uploads/.ragsystem-manifest.json",
  ]);

  await bridge.collectOutputs(lease, owner, driver);
  assert.equal(added.length, 1);
  assert.equal(added[0].sessionId, "session-1");
  assert.equal(added[0].input.originalName, "result.txt");
  assert.equal(Buffer.from(added[0].input.buffer).toString("utf8"), "done");
});
