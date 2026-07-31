import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArtifactToolAfterHook, createArtifactsPlugin } from "../dist/index.js";
import { FilesystemArtifactService } from "../dist/storage/filesystem/filesystem-artifact-service.js";
import { POSTGRES_ARTIFACT_MIGRATIONS } from "../dist/storage/postgres/artifact-schema.js";

test("Artifact plugin registers its contributions and owns storage lifecycle", async () => {
  const events = [];
  const contributions = {};
  const plugin = createArtifactsPlugin({
    storage: {
      applicationForTenant: () => artifactApplication(),
      start: () => { events.push("start"); },
      stop: () => { events.push("stop"); },
    },
    sessionAccess: {},
  });

  plugin.register({
    capabilities: {},
    hooks: { on: (event, handler) => { contributions.hook = { event, handler }; } },
    routes: { register: (scope, prefix) => { contributions.route = { scope, prefix }; } },
    runtimes: {},
    resources: { register: (kind, value) => { contributions.resource = { kind, value }; } },
    tools: {},
  });
  await plugin.start();
  await plugin.stop();

  assert.deepEqual(contributions.route, { scope: "tenant", prefix: "/api/artifacts" });
  assert.equal(contributions.hook.event, "tool.after");
  assert.equal(contributions.resource.kind, "ragsystem.skill-source");
  assert.match(contributions.resource.value, /[\\/]skills$/);
  assert.deepEqual(events, ["start", "stop"]);
});

test("Artifact hook persists an embedded protocol and returns a durable reference", async () => {
  const calls = [];
  const hook = createArtifactToolAfterHook({
    storage: {
      applicationForTenant(tenantId) {
        assert.equal(tenantId, "tenant-a");
        return artifactApplication({
          createArtifact: async (input) => {
            calls.push(input);
            return artifactRecord();
          },
        });
      },
    },
  });

  const output = await hook({
    toolName: "execute_skill_script",
    arguments: {},
    result: toolResult({
      title: "Rainfall",
      artifact: {
        viz_type: "chart",
        sub_type: "bar",
        title: "Rainfall",
        config: { series: [{ data: [1, 2] }] },
      },
    }),
    ctx: { tenantId: "tenant-a", sessionId: "session-a", runId: "run-a" },
  });

  assert.deepEqual(calls, [{
    sessionId: "session-a",
    vizType: "chart",
    subType: "bar",
    title: "Rainfall",
    config: { series: [{ data: [1, 2] }] },
    asset: null,
  }]);
  assert.deepEqual(output.modifiedResult.content, {
    title: "Rainfall",
    artifact_id: "art_test",
    viz_type: "chart",
    artifact_type: "json",
    mime_type: null,
  });
  assert.deepEqual(output.modifiedResult.metadata, {
    artifact_id: "art_test",
    artifact_persisted: true,
  });
  assert.equal(output.modifiedResult.outputType, "chart");
  assert.match(output.modifiedResult.llmHint, /\[artifact:art_test\]/);
});

test("Filesystem Artifact storage creates, revises, and deletes managed files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-storage-"));
  try {
    const service = new FilesystemArtifactService({ dataRoot: root });
    const created = service.createArtifact({
      sessionId: "session-a",
      vizType: "chart",
      config: { axis: { min: 0 }, series: [1] },
      title: "Rainfall",
    });

    assert.equal(service.listArtifacts("session-a").length, 1);
    service.reviseArtifact({
      artifactId: created.artifact_id,
      configPatch: { axis: { max: 10 } },
    });
    assert.deepEqual(service.getArtifact(created.artifact_id).config, {
      axis: { min: 0, max: 10 },
      series: [1],
    });
    assert.equal(service.deleteArtifact(created.artifact_id), true);
    assert.equal(fs.existsSync(created.descriptor_path), false);
    assert.deepEqual(service.listArtifacts("session-a"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Filesystem Artifact storage keeps binary content behind the artifact API", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-binary-"));
  try {
    const service = new FilesystemArtifactService({ dataRoot: root });
    const created = service.createArtifact({
      sessionId: "session-a",
      vizType: "map",
      subType: "raster",
      config: { bounds: [[0, 100], [10, 110]] },
      asset: { body: Buffer.from([137, 80, 78, 71]), mimeType: "image/png", filename: "temperature.png" },
    });
    const descriptor = service.getArtifact(created.artifact_id);
    assert.equal(descriptor.artifact_type, "binary");
    assert.equal(descriptor.content_url, `/api/artifacts/${created.artifact_id}/content`);
    assert.equal(descriptor.asset.filename, "temperature.png");
    assert.deepEqual(service.getArtifactContent(created.artifact_id), {
      body: Buffer.from([137, 80, 78, 71]),
      mimeType: "image/png",
      filename: "temperature.png",
    });
    assert.equal(service.deleteArtifact(created.artifact_id), true);
    assert.equal(fs.existsSync(created.asset_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact migrations own plugin metadata", () => {
  const sql = POSTGRES_ARTIFACT_MIGRATIONS.map((migration) => migration.sql).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS artifact_metadata/);
  assert.match(sql, /PRIMARY KEY \(tenant_id, artifact_id\)/);
});

function toolResult(content) {
  return {
    success: true,
    toolName: "execute_skill_script",
    summary: "done",
    answer: null,
    outputType: "json",
    content,
    metadata: {},
    artifacts: [],
    llmHint: null,
  };
}

function artifactRecord() {
  return {
    artifact_id: "art_test",
    viz_type: "chart",
    sub_type: "bar",
    title: "Rainfall",
    version: 1,
    descriptor_path: "artifact.json",
    asset_path: null,
    artifact_type: "json",
    mime_type: null,
    session_id: "session-a",
    created_at: 1,
    updated_at: 1,
  };
}

function artifactApplication(overrides = {}) {
  return {
    getArtifact() {},
    getArtifactContent() { return null; },
    listArtifacts() { return []; },
    getArtifactSessionId() { return null; },
    async createArtifact() { return artifactRecord(); },
    async reviseArtifact() { return artifactRecord(); },
    deleteArtifact() { return false; },
    deleteSessionArtifacts() { return 0; },
    ...overrides,
  };
}
