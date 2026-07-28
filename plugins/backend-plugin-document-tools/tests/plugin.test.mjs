import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  createDocumentToolsPlugin,
  createLocalDocumentToolsRuntimeFactory,
} from "../dist/index.js";

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
    resources: [{ kind: "document-tools.enabled", value: false }],
  }), { document: null });
});

test("local document runtime owns file writes and consumes the edit-history resource", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-tools-"));
  const edits = [];
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
      resources: [{
        kind: "document-tools.edit-history",
        value: { trackEdit: (sessionId, filePath) => edits.push({ sessionId, filePath }) },
      }],
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
