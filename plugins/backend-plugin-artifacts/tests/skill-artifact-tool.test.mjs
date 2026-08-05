import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createArtifactToolAfterHook,
  createFilesystemArtifactStorage,
  createSkillArtifactTools,
} from "../dist/index.js";

test("create_skill_artifact builds a complete Skill Artifact bundle", async () => {
  assert.deepEqual(createSkillArtifactTools(agent([])), []);
  const [tool] = createSkillArtifactTools(agent(["create_skill_artifact"]));
  assert.equal(tool.name, "create_skill_artifact");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-artifact-tool-"));
  try {
    const storage = createFilesystemArtifactStorage({ resolveDataRoot: () => root });
    const prepared = await tool.call({
      name: "incident-response",
      description: "Handle production incidents",
      content: "## Triage\n\nCollect evidence first.",
      metadata: { ragsystem_requires_tools: "read_file" },
      files: [
        { path: "scripts/check.py", content: "print('ok')\n", media_type: "text/x-python" },
        { path: "resources/schema.json", content: "{\"ok\":true}\n", media_type: "application/json" },
      ],
    }, {});
    assert.equal(prepared.success, true);
    assert.equal(prepared.content.artifact.kind, "skill");

    const after = await createArtifactToolAfterHook({ storage })({
      toolName: "create_skill_artifact",
      arguments: {},
      result: prepared,
      ctx: {
        tenantId: "tenant-a",
        sessionId: "session-a",
        runId: "run-a",
        toolCallId: "tool-call-a",
      },
    });
    const result = after.modifiedResult;
    assert.equal(result.success, true);
    assert.equal(result.content.artifact_kind, "skill");
    assert.equal(result.content.artifact_revision, 1);
    assert.equal(typeof result.content.artifact_id, "string");
    assert.equal("artifact" in result.content, false);

    const application = storage.applicationForTenant("tenant-a");
    const manifest = await application.getArtifact(result.content.artifact_id);
    assert.equal(manifest.session_id, "session-a");
    assert.deepEqual(manifest.assets.map((asset) => asset.filename), [
      "SKILL.md",
      "scripts/check.py",
      "resources/schema.json",
    ]);
    assert.deepEqual(manifest.metadata.skill_bundle_paths, {
      "skill-file-1": "SKILL.md",
      "skill-file-2": "scripts/check.py",
      "skill-file-3": "resources/schema.json",
    });
    const skillMdAsset = manifest.assets.find((asset) => asset.filename === "SKILL.md");
    const skillMd = await application.getArtifactAsset(manifest.artifact_id, skillMdAsset.asset_id);
    assert.match(skillMd.body.toString("utf8"), /name: incident-response/);
    assert.match(skillMd.body.toString("utf8"), /ragsystem_requires_tools/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("create_skill_artifact rejects duplicate and unsafe bundle paths", async () => {
  const [tool] = createSkillArtifactTools(agent(["create_skill_artifact"]));
  const base = {
    name: "invalid-bundle",
    description: "Invalid bundle",
    content: "Instructions",
  };
  const duplicate = await tool.call({ ...base, files: [{ path: "SKILL.md", content: "override" }] }, {});
  assert.equal(duplicate.success, false);
  assert.match(duplicate.summary, /Duplicate or reserved/);
  const traversal = await tool.call({ ...base, files: [{ path: "../secret.txt", content: "secret" }] }, {});
  assert.equal(traversal.success, false);
  assert.match(traversal.summary, /Invalid Skill file path/);
});

function agent(enabledTools) {
  return { tools: { enabled_tools: enabledTools } };
}
