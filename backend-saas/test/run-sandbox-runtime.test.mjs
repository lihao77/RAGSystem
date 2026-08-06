import assert from "node:assert/strict";
import test from "node:test";

import { SaaSSandboxFileBridge } from "../dist/adapters/saas/sandbox/sandbox-file-bridge.js";
import { createSaaSRuntimeContainer } from "../dist/adapters/saas/composition/saas-runtime-container.js";
import { SaaSTenantRuntimeRegistry } from "../dist/adapters/saas/composition/saas-tenant-runtime-registry.js";

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
