import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SKILL_AUTHORING_TOOL_DESCRIPTORS,
  SkillsAgentConfigService,
  SkillAuthoringService,
  SkillToolService,
  createSkillAuthoringTools,
  createSkillTools,
  resolveArtifactApplication,
  resolveArtifactResource,
  resolveBuiltinSkillSources,
} from "../dist/index.js";

class MemoryConfigStore {
  rows = new Map();
  key(value) { return `${value.teamName}\0${value.agentName}`; }
  async get(key) { return this.rows.get(this.key(key)) ?? null; }
  async put(key, value) { this.rows.set(this.key(key), structuredClone(value)); }
  async delete(key) { return this.rows.delete(this.key(key)); }
  async purgeSkillReference() { return []; }
}

class MemoryDraftStore {
  rows = new Map();
  async list() { return [...this.rows.values()].map((value) => structuredClone(value)); }
  async get(id) { return structuredClone(this.rows.get(id) ?? null); }
  async create(value) { this.rows.set(value.id, structuredClone(value)); }
  async update(expected, value) {
    const current = this.rows.get(value.id);
    if (!current || current.revision !== expected) return false;
    this.rows.set(value.id, structuredClone(value));
    return true;
  }
  async delete(id, expected) {
    const current = this.rows.get(id);
    if (!current || current.revision !== expected) return false;
    this.rows.delete(id);
    return true;
  }
}

function skillMarkdown(name = "review-code") {
  return `---\nname: ${name}\ndescription: Review code\nmetadata:\n  custom_flag: true\n---\nReview the code.\n`;
}

function artifactApplication() {
  const files = [
    ["SKILL.md", Buffer.from(skillMarkdown()), "text/markdown; charset=utf-8"],
    ["scripts/check.py", Buffer.from("print('ok')\n"), "text/x-python; charset=utf-8"],
    ["resources/schema.json", Buffer.from('{"ok":true}\n'), "application/json"],
  ];
  const assets = files.map(([filename, body, media_type], index) => ({
    asset_id: `asset-${index}`,
    filename,
    media_type,
    size: body.length,
    sha256: cryptoHash(body),
  }));
  return {
    async getArtifact() {
      return { artifact_id: "artifact-1", revision: 1, session_id: "session-1", kind: "skill", title: "Review code", status: "ready", assets, provenance: {} };
    },
    async getArtifactAsset(_artifactId, assetId) {
      const index = assets.findIndex((asset) => asset.asset_id === assetId);
      const [filename, body, mediaType] = files[index];
      return { body, filename, mediaType, sha256: assets[index].sha256 };
    },
  };
}

function cryptoHash(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function memoryLibrary() {
  const packages = new Map();
  return {
    packages,
    async listSkills() { return [...packages.values()].map(({ name }) => ({ name, source_type: "user_global" })); },
    async getSkillDetail(name) {
      const value = packages.get(name);
      if (!value) throw new Error("not found");
      return { source_type: "user_global", description: value.description, content: value.content };
    },
    async createSkillBundle(input) { packages.set(input.name, structuredClone(input)); return input; },
    async matchesSkillBundle(name, files) {
      const value = packages.get(name);
      if (!value || value.files.length !== files.length) return false;
      return value.files.every((file) => {
        const expected = files.find((item) => item.relativePath === file.relativePath);
        return expected && Buffer.from(expected.body).equals(Buffer.from(file.body));
      });
    },
  };
}

test("Skills config remains separate from enabled Skill bindings", async () => {
  const service = new SkillsAgentConfigService(new MemoryConfigStore());
  await service.put({ teamName: "product", agentName: "writer" }, { enabled_skills: ["review-code"] });
  assert.deepEqual(await service.getEffective({ teamName: "product", agentName: "writer" }), { enabled_skills: ["review-code"] });
  assert.deepEqual(await service.getEffective({ teamName: "default", agentName: "writer" }), { enabled_skills: [] });
});

test("Skill tools expose execution only for explicitly enabled Skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tools-"));
  try {
    const builtinRoot = path.join(root, "builtin", "review-code");
    fs.mkdirSync(builtinRoot, { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, "SKILL.md"), skillMarkdown());
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin") });
    const agent = { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} };
    assert.equal(createSkillTools({ skillTools: service, agent, config: { enabled_skills: [] } }).length, 0);
    assert.deepEqual(createSkillTools({ skillTools: service, agent, config: { enabled_skills: ["review-code"] } }).map((tool) => tool.name), ["activate_skill", "load_skill_resource", "execute_skill_script"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execute_skill_script runs from the shared workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-workspace-"));
  try {
    const builtinRoot = path.join(root, "builtin", "review-code");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(builtinRoot, "scripts"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, "SKILL.md"), skillMarkdown());
    fs.writeFileSync(path.join(builtinRoot, "scripts", "check.py"), [
      "import json",
      "import os",
      "from pathlib import Path",
      "request = Path(__import__('sys').argv[1]).read_text(encoding='utf-8')",
      "Path('script-output.txt').write_text(request, encoding='utf-8')",
      "print(json.dumps({'cwd': os.getcwd(), 'workspace': os.environ['SESSION_WORKSPACE_DIR'], 'request': request}))",
    ].join("\n"));
    fs.writeFileSync(path.join(workspace, "request.json"), "{\"ok\":true}\n");
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin") });
    const result = await service.executeSkillScript(
      { skillName: "review-code", scriptName: "check.py", arguments: ["request.json"] },
      { sessionId: "session-skill", runId: "run-skill", workspaceRoot: workspace },
      { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} },
      { enabled_skills: ["review-code"] },
    );
    assert.equal(result.success, true, result.summary);
    assert.equal(result.content.cwd, workspace);
    assert.equal(result.content.workspace, workspace);
    assert.equal(result.content.request, "{\"ok\":true}\n");
    assert.equal(fs.readFileSync(path.join(workspace, "script-output.txt"), "utf8").replaceAll("\r\n", "\n"), "{\"ok\":true}\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact submission copies a complete bundle and stays idempotent", async () => {
  const library = memoryLibrary();
  const service = new SkillAuthoringService(new MemoryDraftStore(), library, artifactApplication());
  const candidate = await service.submitArtifact("artifact-1", 1, { sourceSessionId: "session-1" });
  assert.equal(candidate.bundle_assets.length, 3);
  assert.equal((await service.submitArtifact("artifact-1", 1, { sourceSessionId: "session-1" })).id, candidate.id);
  const published = await service.publishDraft(candidate.id, candidate.revision);
  assert.equal(published.status, "published");
  assert.equal(library.packages.get("review-code").files.length, 3);
  await assert.rejects(service.submitArtifact("artifact-1", 1), /当前 Session/);
});

test("auto approval publishes a valid Skill candidate after Artifact submission", async () => {
  const library = memoryLibrary();
  const service = new SkillAuthoringService(
    new MemoryDraftStore(),
    library,
    artifactApplication(),
    { getSection: (key) => key === "skills" ? { approval: { auto_publish_candidates: true } } : undefined },
  );
  const candidate = await service.submitArtifact("artifact-1", 1, { sourceSessionId: "session-1" });
  assert.equal(candidate.status, "published");
  assert.equal(library.packages.has("review-code"), true);
});

test("Skill authoring tools never return copied base64 bundle bodies", async () => {
  const service = new SkillAuthoringService(new MemoryDraftStore(), memoryLibrary(), artifactApplication());
  const tools = new Map(createSkillAuthoringTools({ authoring: service, agentName: "builder" }).map((tool) => [tool.name, tool]));
  const submitted = await tools.get("submit_skill_artifact").call(
    { artifact_id: "artifact-1", expected_revision: 1 },
    { sessionId: "session-1" },
  );
  assert.equal(submitted.success, true);
  assert.equal(submitted.content.bundle_assets, undefined);
  assert.equal(submitted.content.bundle_asset_count, 3);

  const loaded = await tools.get("get_skill_draft").call({ draft_id: submitted.content.draft_id }, {});
  assert.equal(loaded.success, true);
  assert.equal(loaded.content.bundle_assets.length, 3);
  assert.equal("body_base64" in loaded.content.bundle_assets[0], false);

  const listed = await tools.get("list_skill_drafts").call({}, {});
  assert.equal(listed.success, true);
  assert.equal(listed.content[0].content, undefined);
  assert.equal(JSON.stringify(listed.content).includes("body_base64"), false);
});

test("publishing with canonical field overrides remains idempotent", async () => {
  const library = memoryLibrary();
  const service = new SkillAuthoringService(new MemoryDraftStore(), library, artifactApplication());
  const candidate = await service.submitArtifact("artifact-1", 1, {
    sourceSessionId: "session-1",
    name: "renamed-review",
    description: "Renamed review skill",
  });
  const published = await service.publishDraft(candidate.id, candidate.revision);
  const repeated = await service.publishDraft(published.id, published.revision);
  assert.equal(repeated.revision, published.revision);
  assert.match(
    Buffer.from(library.packages.get("renamed-review").files.find((file) => file.relativePath === "SKILL.md").body).toString("utf8"),
    /name: renamed-review/,
  );
});

test("Deleting a release restores its copied candidate as an editable draft", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library, artifactApplication());
  const candidate = await service.submitArtifact("artifact-1", 1, { sourceSessionId: "session-1" });
  const published = await service.publishDraft(candidate.id, candidate.revision);
  library.packages.delete(published.name);
  const restored = await service.restoreCandidateAfterReleaseDelete(published.name);
  assert.equal(restored.status, "draft");
  assert.equal(restored.revision, published.revision + 1);
  assert.equal(restored.published_at, null);
});

test("Authoring tools contain only read candidate and Artifact submission operations", () => {
  assert.deepEqual(SKILL_AUTHORING_TOOL_DESCRIPTORS.map((tool) => tool.name), ["list_skill_drafts", "get_skill_draft", "submit_skill_artifact"]);
});

test("Artifact application resources use the structured tenant and access port", async () => {
  const calls = [];
  const value = {
    applicationForTenant: async (tenantId) => ({ tenantId }),
    assertReadable: async (_request, sessionId) => { calls.push(sessionId); },
  };
  const resources = [{ pluginId: "artifacts", kind: "ragsystem.artifact-application", value }];
  assert.deepEqual(await resolveArtifactApplication(resources, "tenant-a"), { tenantId: "tenant-a" });
  assert.equal(resolveArtifactResource(resources), value);
  await value.assertReadable({}, "session-1");
  assert.deepEqual(calls, ["session-1"]);
});

test("Skill source resources require absolute roots", () => {
  assert.throws(() => resolveBuiltinSkillSources([
    { pluginId: "bad", kind: "ragsystem.skill-source", value: "relative" },
  ]), /absolute path/);
});
