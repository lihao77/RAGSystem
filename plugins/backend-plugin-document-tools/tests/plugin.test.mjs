import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import {
  backendPluginModule,
  createDocumentToolsPlugin,
  createLocalDocumentToolsRuntimeFactory,
  DOCUMENT_TOOLS_RUNTIME_CAPABILITY,
} from "../dist/index.js";
import { SaaSDocumentToolService } from "../dist/storage/saas/sandbox-document-tools.js";

const descriptorNames = ["read_file", "write_file", "edit_file", "preview_data_structure"];

test("document tool descriptors are contributed only when the plugin is installed", async () => {
  const empty = new BackendPluginManager();
  await empty.register();
  assert.deepEqual(empty.runtimeContributions().listTools(), []);

  const installed = new BackendPluginManager([
    createDocumentToolsPlugin({ runtimeFactory: () => ({ document: null }) }),
  ]);
  await installed.register();
  assert.deepEqual(
    installed.runtimeContributions().listTools().map((tool) => tool.name),
    descriptorNames,
  );
});

test("standard plugin module selects the deployment runtime without product wiring", async () => {
  const plugin = await backendPluginModule.create({ config: undefined });
  const manager = new BackendPluginManager([plugin]);
  await manager.register();
  const contributions = manager.runtimeContributions();

  const local = await contributions.createRuntime({
    deploymentKind: "local",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.toolPolicy, { executionToolsEnabled: false }, "test-host")],
  });
  assert.deepEqual(local.capabilities.require(DOCUMENT_TOOLS_RUNTIME_CAPABILITY), { document: null });
  local.dispose();

  const supplied = fakeSandboxLease();
  const saas = await contributions.createRuntime({
    deploymentKind: "saas",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.sandboxLease, supplied, "test-host")],
  });
  assert.ok(saas.capabilities.require(DOCUMENT_TOOLS_RUNTIME_CAPABILITY).document);
  saas.dispose();
});

test("standard plugin module rejects unsupported configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /does not accept configuration/,
  );
});

test("document tool visibility follows the agent enabled_tools list", async () => {
  const manager = new BackendPluginManager([
    createDocumentToolsPlugin({ runtimeFactory: () => ({ document: fakeDocumentPort() }) }),
  ]);
  await manager.register();
  const contributions = manager.runtimeContributions();
  const runtime = await contributions.createRuntime({});

  assert.deepEqual(
    (await contributions.createTools(toolContext(runtime.capabilities, []))).map((tool) => tool.name),
    [],
  );
  assert.deepEqual(
    (await contributions.createTools(toolContext(runtime.capabilities, ["read_file", "edit_file"]))).map((tool) => tool.name),
    ["read_file", "edit_file"],
  );
});

test("local document runtime can be disabled by a deployment resource", () => {
  const factory = createLocalDocumentToolsRuntimeFactory();
  assert.deepEqual(factory({
    deploymentKind: "local",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.toolPolicy, { executionToolsEnabled: false }, "test-host")],
  }), { document: null });
});

test("local document runtime owns file writes and consumes the edit-history resource", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-tools-"));
  const edits = [];
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
      resources: [provideBackendResource(BACKEND_HOST_RESOURCES.fileEditHistory, { trackEdit: (sessionId, filePath) => edits.push({ sessionId, filePath }) }, "test-host")],
    });
    const result = await runtime.document.writeFile(
      { content: "hello", filePath: "note.txt", filePathSpace: "transient" },
      { sessionId: "session-a", runId: "run-a" },
      { custom_params: {} },
      {
        isApproved: () => false,
        assertWithin: (candidatePath) => candidatePath,
      },
    );

    assert.equal(result.success, true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].sessionId, "session-a");
    assert.equal(fs.readFileSync(edits[0].filePath, "utf8"), "hello");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("document relative writes and reads use the same workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-workspace-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    });
    const context = { sessionId: "session-workspace", runId: "run-workspace" };
    const pathPolicy = {
      isApproved: () => false,
      assertWithin: (candidatePath) => candidatePath,
    };
    const written = await runtime.document.writeFile(
      { content: "workspace content", filePath: "shared.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(written.success, true, written.summary);
    const read = runtime.document.readFile(
      { filePath: "shared.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(read.success, true, read.summary);
    assert.equal(read.content, "workspace content");
    assert.equal(read.metadata.file_path, written.metadata.file_path);
    assert.equal(read.metadata.execution_paths.workspace, path.join(root, "sessions", "session-workspace", "workspace"));
    assert.deepEqual(Object.keys(read.metadata.execution_paths).sort(), ["artifacts", "transient", "uploads", "workspace"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local and SaaS document adapters share encoding and line-range policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-policy-"));
  try {
    const local = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    }).document;
    const context = { sessionId: "session-policy", runId: "run-policy" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    await local.writeFile({ content: "a\nb\nc\n", filePath: "lines.txt" }, context, { custom_params: {} }, pathPolicy);

    const saas = new SaaSDocumentToolService({
      async withLease(_context, operation) {
        return operation({ id: "lease", owner: {}, createdAt: "now" }, {
          async readFile() { return { content: "a\nb\nc\n", size: 6 }; },
          async writeFile() { return { size: 0 }; },
          async editFile() { return { size: 0, replacements: 0 }; },
          async previewFile() { return { fileType: "text", fileSize: 6, structure: {} }; },
        });
      },
      async releaseRun() {},
      async closeAll() {},
    });

    const localRead = local.readFile({ filePath: "lines.txt", offset: 2, limit: 1 }, context, { custom_params: {} }, pathPolicy);
    const saasRead = await saas.readFile({ filePath: "lines.txt", offset: 2, limit: 1 }, context);
    assert.equal(localRead.content, saasRead.content);
    for (const key of ["total_lines", "start_line", "end_line", "has_more", "next_offset"]) {
      assert.equal(localRead.metadata[key], saasRead.metadata[key], key);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function toolContext(capabilities, enabledTools) {
  return {
    tenantId: "tenant-a",
    teamName: null,
    agent: {
      agent_name: "tester",
      tools: { enabled_tools: enabledTools },
      custom_params: {},
    },
    pathAccessPolicy: {},
    capabilities,
  };
}

function fakeDocumentPort() {
  return {
    readFile: () => success("read_file"),
    writeFile: async () => success("write_file"),
    editFile: async () => success("edit_file"),
    previewDataStructure: () => success("preview_data_structure"),
    getExternalCandidates: () => [],
  };
}

function success(toolName) {
  return {
    success: true,
    toolName,
    summary: "ok",
    answer: null,
    outputType: "text",
    content: "ok",
    metadata: {},
    artifacts: [],
    llmHint: null,
  };
}

function fakeSandboxLease() {
  return {
    async withLease(_context, operation) {
      return operation({ id: "lease", owner: { tenantId: "tenant", userId: "user", sessionId: "session", runId: "run" }, createdAt: "now" }, {
        async readFile() { return { content: "", size: 0 }; },
        async writeFile() { return { size: 0 }; },
        async editFile() { return { size: 0, replacements: 0 }; },
        async previewFile() { return { fileType: "text", fileSize: 0, structure: {} }; },
      });
    },
    async releaseRun() {},
    async closeAll() {},
  };
}
