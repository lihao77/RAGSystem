import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createArtifactToolAfterHook,
  createFilesystemArtifactStagingProvider,
} from "../dist/index.js";
import { FilesystemArtifactApplication } from "../dist/storage/filesystem/filesystem-artifact-application.js";
import { FilesystemArtifactService } from "../dist/storage/filesystem/filesystem-artifact-service.js";

test("staged Asset is claimed by execution owner and consumed after persistence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-staging-"));
  try {
    const provider = createFilesystemArtifactStagingProvider();
    const staging = provider.forTenant("tenant-a", root);
    const run = await staging.createRun(owner());
    const bytes = Buffer.from([1, 3, 5, 7, 9]);
    fs.writeFileSync(path.join(run.outputDirectory, "temperature.tif"), bytes);
    const [staged] = await staging.registerOutputs(run.stageRunId, [{
      relativePath: "temperature.tif",
      filename: "temperature.tif",
      mediaType: "image/tiff",
    }]);

    const application = new FilesystemArtifactApplication(new FilesystemArtifactService({ dataRoot: root }));
    const hook = createArtifactToolAfterHook({
      storage: { applicationForTenant: () => application },
      staging: provider,
    });
    const output = await hook({
      toolName: "execute_skill_script",
      arguments: {},
      result: toolResult(staged.stagedFileId),
      ctx: {
        tenantId: "tenant-a",
        sessionId: "session-a",
        runId: "run-a",
        toolCallId: "tool-a",
      },
    });

    assert.equal(output.modifiedResult.metadata.artifact_persisted, true);
    assert.equal(fs.existsSync(path.dirname(run.outputDirectory)), false);
    const manifest = await application.getArtifact(output.modifiedResult.content.artifact_id);
    assert.equal(manifest.assets[0].size, bytes.length);
    assert.equal(manifest.assets[0].sha256, staged.sha256);
    assert.deepEqual((await application.getArtifactAsset(manifest.artifact_id, "data")).body, bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging enforces relative paths and exact execution ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-staging-owner-"));
  try {
    const provider = createFilesystemArtifactStagingProvider();
    const staging = provider.forTenant("tenant-a", root);
    const invalidRun = await staging.createRun(owner());
    await assert.rejects(
      staging.registerOutputs(invalidRun.stageRunId, [{ relativePath: "../outside.bin" }]),
      /相对路径|无效|越界/,
    );
    await staging.discardRun(invalidRun.stageRunId);

    const run = await staging.createRun(owner());
    fs.writeFileSync(path.join(run.outputDirectory, "data.bin"), Buffer.from([2, 4, 6]));
    const [staged] = await staging.registerOutputs(run.stageRunId, [{ relativePath: "data.bin" }]);
    await assert.rejects(
      provider.claimFiles({
        tenantId: "tenant-a",
        sessionId: "session-b",
        runId: "run-a",
        toolCallId: "tool-a",
        stagedFileIds: [staged.stagedFileId],
      }),
      /其他 session/,
    );

    const claims = await provider.claimFiles({
      tenantId: "tenant-a",
      sessionId: "session-a",
      runId: "run-a",
      toolCallId: "tool-a",
      stagedFileIds: [staged.stagedFileId],
    });
    await provider.rollbackClaims(claims);
    assert.equal(fs.existsSync(claims[0].sourcePath), true);
    const retried = await provider.claimFiles({
      tenantId: "tenant-a",
      sessionId: "session-a",
      runId: "run-a",
      toolCallId: "tool-a",
      stagedFileIds: [staged.stagedFileId],
    });
    await provider.commitClaims(retried);
    assert.equal(fs.existsSync(path.dirname(run.outputDirectory)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed Artifact persistence rolls a claimed staging run back to ready", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-staging-rollback-"));
  try {
    const provider = createFilesystemArtifactStagingProvider();
    const staging = provider.forTenant("tenant-a", root);
    const run = await staging.createRun(owner());
    fs.writeFileSync(path.join(run.outputDirectory, "data.bin"), Buffer.from([8, 8, 8]));
    const [staged] = await staging.registerOutputs(run.stageRunId, [{ relativePath: "data.bin" }]);
    const hook = createArtifactToolAfterHook({
      storage: { applicationForTenant: () => ({ createArtifact: async () => { throw new Error("storage down"); } }) },
      staging: provider,
    });
    const output = await hook({
      toolName: "execute_skill_script",
      arguments: {},
      result: toolResult(staged.stagedFileId, "data.bin", "application/octet-stream"),
      ctx: { tenantId: "tenant-a", sessionId: "session-a", runId: "run-a", toolCallId: "tool-a" },
    });
    assert.match(output.modifiedResult.metadata.artifact_error, /storage down/);
    assert.equal(output.modifiedResult.success, false);
    assert.match(output.modifiedResult.content, /storage down/);
    assert.equal(fs.existsSync(path.join(run.outputDirectory, "data.bin")), true);
    const claims = await provider.claimFiles({
      tenantId: "tenant-a",
      sessionId: "session-a",
      runId: "run-a",
      toolCallId: "tool-a",
      stagedFileIds: [staged.stagedFileId],
    });
    await provider.rollbackClaims(claims);
    await staging.discardRun(run.stageRunId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function owner() {
  return { sessionId: "session-a", runId: "run-a", toolCallId: "tool-a" };
}

function toolResult(stagedFileId, filename = "temperature.tif", mediaType = "image/tiff") {
  return {
    success: true,
    toolName: "execute_skill_script",
    summary: "done",
    answer: null,
    outputType: "json",
    content: {
      artifact: {
        schema_version: 2,
        kind: "map.raster",
        subtype: "geotiff",
        title: "Temperature",
        assets: [{
          asset_id: "data",
          role: "data",
          filename,
          media_type: mediaType,
          staged_file_id: stagedFileId,
        }],
        presentations: [{
          presentation_id: "map",
          surface: "map",
          renderer: "map.raster",
          assets: { source: "data" },
          config: {},
        }],
      },
    },
    metadata: {},
    artifacts: [],
    llmHint: null,
  };
}
