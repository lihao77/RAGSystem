import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_STAGING_RESOURCE,
  createArtifactToolAfterHook,
  createArtifactsPlugin,
  parseArtifactManifest,
} from "../dist/index.js";
import { FilesystemArtifactService } from "../dist/storage/filesystem/filesystem-artifact-service.js";
import { POSTGRES_ARTIFACT_MIGRATIONS } from "../dist/storage/postgres/artifact-schema.js";

test("Artifact plugin registers its contributions and owns storage lifecycle", async () => {
  const events = [];
  const contributions = {};
  const resources = [];
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
    resources: { register: (token, value) => { resources.push({ token, value }); } },
    tools: { register: (factory, descriptors) => { contributions.tools = { factory, descriptors }; } },
  });
  await plugin.start();
  await plugin.stop();

  assert.deepEqual(contributions.route, { scope: "tenant", prefix: "/api/artifacts" });
  assert.equal(contributions.hook.event, "tool.after");
  const skillSource = resources.find((item) => item.token.id === "ragsystem.skill-source").value;
  assert.match(skillSource, /[\\/]skills$/);
  assert.equal(fs.existsSync(path.join(skillSource, "visualization", "SKILL.md")), true);
  assert.equal(typeof resources.find((item) => item.token.id === ARTIFACT_STAGING_RESOURCE.id).value.forTenant, "function");
  assert.deepEqual(events, ["start", "stop"]);
});

test("Artifact hook persists a V2 spatial manifest with multiple embedded assets", async () => {
  const calls = [];
  const hook = createArtifactToolAfterHook({
    storage: {
      applicationForTenant() {
        return artifactApplication({
          createArtifact: async (input) => {
            calls.push(input);
            return artifactRecord({ kind: "map.raster", asset_count: 2, presentation_count: 0 });
          },
        });
      },
    },
  });

  const output = await hook({
    toolName: "execute_skill_script",
    arguments: {},
    result: toolResult({
      artifact: {
        schema_version: 2,
        kind: "map.raster",
        subtype: "nc.aggregate",
        title: "Sea temperature",
        assets: [
          { asset_id: "data", role: "data", filename: "temperature.tif", media_type: "image/tiff", data_base64: Buffer.from([1, 2, 3]).toString("base64") },
          { asset_id: "preview", role: "preview", filename: "temperature.png", media_type: "image/png", data_base64: Buffer.from([137, 80, 78, 71]).toString("base64") },
        ],
        presentations: [],
        metadata: { spatial: { crs: "EPSG:4326", bounds: [100, 0, 110, 10] } },
      },
    }),
    ctx: { tenantId: "tenant-a", sessionId: "session-a", runId: "run-a" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "map.raster");
  assert.equal(calls[0].assets.length, 2);
  assert.deepEqual(output.modifiedResult.content, {
    artifact_id: "art_test",
    artifact_kind: "map.raster",
    artifact_revision: 1,
    artifact_status: "ready",
    asset_count: 2,
    presentation_count: 0,
  });
  assert.equal(output.modifiedResult.metadata.artifact_persisted, true);
  assert.equal(output.modifiedResult.outputType, "map.raster");
});

test("Artifact results expose stable identifiers without Skill-specific handling", async () => {
  const hook = createArtifactToolAfterHook({
    storage: {
      applicationForTenant: () => artifactApplication({
        createArtifact: async () => artifactRecord({
          artifact_id: "art_skill_123",
          kind: "skill",
          subtype: null,
          revision: 3,
          asset_count: 4,
          presentation_count: 0,
        }),
      }),
    },
  });

  const output = await hook({
    toolName: "execute_skill_script",
    arguments: {},
    result: toolResult({ artifact: { schema_version: 2, kind: "skill", assets: [] } }),
    ctx: { tenantId: "tenant-a", sessionId: "session-a", runId: "run-a" },
  });

  assert.equal(output.modifiedResult.content.artifact_id, "art_skill_123");
  assert.equal(output.modifiedResult.content.artifact_kind, "skill");
  assert.equal(output.modifiedResult.content.artifact_revision, 3);
  assert.equal(output.modifiedResult.metadata.artifact_id, "art_skill_123");
  assert.equal(output.modifiedResult.metadata.artifact_kind, "skill");
  assert.equal(output.modifiedResult.metadata.artifact_revision, 3);
  assert.equal(output.modifiedResult.metadata.artifact_status, "ready");
  assert.equal(output.modifiedResult.summary, "done");
  assert.match(output.modifiedResult.llmHint, /art_skill_123/);
});

test("Artifact hook rejects the old V1 protocol", async () => {
  const hook = createArtifactToolAfterHook({ storage: { applicationForTenant: () => artifactApplication() } });
  const output = await hook({
    toolName: "execute_skill_script",
    arguments: {},
    result: toolResult({ artifact: { viz_type: "chart", config: {} } }),
    ctx: { tenantId: "tenant-a", sessionId: "session-a", runId: "run-a" },
  });
  assert.equal(output.modifiedResult.metadata.artifact_error, "artifact.schema_version 必须是 2");
  assert.equal(output.modifiedResult.success, false);
  assert.match(output.modifiedResult.content, /Artifact 处理失败/);
});

test("Filesystem Artifact V2 stores multiple binary assets with checksums and real extensions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-v2-"));
  try {
    const service = new FilesystemArtifactService({ dataRoot: root });
    const created = service.createArtifact({
      sessionId: "session-a",
      kind: "map.raster",
      subtype: "nc.aggregate",
      title: "Temperature",
      assets: [
        { assetId: "data", role: "data", source: { type: "memory", body: Buffer.from([1, 2, 3]) }, mediaType: "image/tiff", filename: "temperature.tif" },
        { assetId: "preview", role: "preview", source: { type: "memory", body: Buffer.from([137, 80, 78, 71]) }, mediaType: "image/png", filename: "temperature.png" },
      ],
      presentations: [],
      metadata: { spatial: { crs: "EPSG:4326", bounds: [100, 0, 110, 10] } },
    });

    const manifest = service.getArtifact(created.artifact_id);
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.kind, "map.raster");
    assert.equal(manifest.assets[0].sha256.length, 64);
    assert.match(manifest.assets[0].content_url, /assets\/data\/content$/);
    assert.deepEqual(service.getArtifactAsset(created.artifact_id, "preview").body, Buffer.from([137, 80, 78, 71]));
    const artifactRoot = path.dirname(created.manifest_path);
    assert.equal(fs.existsSync(path.join(artifactRoot, "assets", "data.tif")), true);
    assert.equal(fs.existsSync(path.join(artifactRoot, "assets", "preview.png")), true);

    const revised = service.reviseArtifact({
      artifactId: created.artifact_id,
      metadata: { analysis: { revised: true } },
    });
    assert.equal(revised.revision, 2);
    assert.deepEqual(service.getArtifact(created.artifact_id).metadata, {
      spatial: { crs: "EPSG:4326", bounds: [100, 0, 110, 10] },
      analysis: { revised: true },
    });
    assert.equal(service.deleteArtifact(created.artifact_id), true);
    assert.equal(fs.existsSync(artifactRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Filesystem Artifact V2 rejects presentations that reference unknown assets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-invalid-"));
  try {
    const service = new FilesystemArtifactService({ dataRoot: root });
    assert.throws(() => service.createArtifact({
      sessionId: "session-a",
      kind: "chart.echarts",
      presentations: [{ presentation_id: "primary", surface: "chart", renderer: "chart.echarts", assets: { data: "missing" }, config: {} }],
    }), /不存在的 asset/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact migrations include a separate V2 metadata table", () => {
  const migration = POSTGRES_ARTIFACT_MIGRATIONS.find((item) => item.version === 3);
  assert.ok(migration);
  assert.match(migration.sql, /artifact_metadata_v2/);
  assert.match(migration.sql, /asset_count/);
});

test("Artifact manifests are strictly V2", () => {
  assert.throws(() => parseArtifactManifest({ schema_version: 1 }), /V2/);
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

function artifactRecord(overrides = {}) {
  return {
    schema_version: 2,
    artifact_id: "art_test",
    session_id: "session-a",
    kind: "chart.echarts",
    subtype: "bar",
    title: "Rainfall",
    status: "ready",
    revision: 1,
    manifest_path: "artifact/manifest.json",
    asset_count: 0,
    presentation_count: 1,
    created_at: new Date(1).toISOString(),
    updated_at: new Date(1).toISOString(),
    ...overrides,
  };
}

function artifactApplication(overrides = {}) {
  return {
    getArtifact() {},
    getArtifactAsset() {},
    listArtifacts() { return []; },
    getArtifactSessionId() { return null; },
    async createArtifact() { return artifactRecord(); },
    async reviseArtifact() { return artifactRecord({ revision: 2 }); },
    deleteArtifact() { return false; },
    deleteSessionArtifacts() { return 0; },
    ...overrides,
  };
}
