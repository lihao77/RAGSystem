import assert from "node:assert/strict";
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
  async delete(id) { return this.rows.delete(id); }
}

function skillMarkdown(name = "review-code") {
  return `---\nname: ${name}\ndescription: Review code\nmetadata:\n  custom_flag: true\n---\nReview the code.\n`;
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
    async replaceSkillBundle(input) { packages.set(input.name, structuredClone(input)); return input; },
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

test("workspace validation failure does not synchronize the system Skill draft", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-draft-invalid-"));
  try {
    const service = new SkillAuthoringService(new MemoryDraftStore(), memoryLibrary());
    const draft = await service.createDraft("workspace-skill", "Workspace Skill");
    const local = await service.materializeDraftToWorkspace(draft, root);
    fs.writeFileSync(path.join(local.workspacePath, "SKILL.md"), "---\nname: workspace-skill\ndescription: Workspace Skill\n---\n");

    await assert.rejects(service.publishWorkspaceDraft(draft.id, root));
    const unchanged = await service.getDraft(draft.id);
    assert.equal(unchanged.revision, 1);
    assert.match(unchanged.content, /reusable instructions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace publish auto-publishes and updates an existing Skill package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-draft-publish-"));
  try {
    const library = memoryLibrary();
    const service = new SkillAuthoringService(
      new MemoryDraftStore(),
      library,
      { getSection: (key) => key === "skills" ? { approval: { auto_publish_candidates: true } } : undefined },
    );
    const draft = await service.createDraft("workspace-skill", "Workspace Skill");
    const local = await service.materializeDraftToWorkspace(draft, root);
    const first = await service.publishWorkspaceDraft(draft.id, root);
    assert.equal(first.published, true);
    assert.equal(first.draft.status, "published");

    fs.writeFileSync(
      path.join(local.workspacePath, "SKILL.md"),
      "---\nname: workspace-skill\ndescription: Workspace Skill\n---\nUpdated reusable instructions.\n",
    );
    const second = await service.publishWorkspaceDraft(draft.id, root);
    assert.equal(second.published, true);
    assert.match(library.packages.get("workspace-skill").content, /Updated reusable instructions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skill authoring tools never return copied base64 bundle bodies", async () => {
  const service = new SkillAuthoringService(new MemoryDraftStore(), memoryLibrary());
  const tools = new Map(createSkillAuthoringTools({ authoring: service, agentName: "builder" }).map((tool) => [tool.name, tool]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-draft-workspace-"));
  try {
    const draft = await service.createDraft("review-code", "Review code");
    const loaded = await tools.get("get_skill_draft").call(
      { draft_id: draft.id },
      { executionPaths: { workspace: root } },
    );
    assert.equal(loaded.success, true);
    assert.equal(loaded.content.bundle_assets, undefined);
    assert.equal(loaded.content.bundle_asset_count, 1);
    assert.equal(fs.existsSync(path.join(loaded.content.workspace_path, "SKILL.md")), true);

    const listed = await tools.get("list_skill_drafts").call({ query: "review" }, {});
    assert.equal(listed.success, true);
    assert.equal(listed.content[0].content, undefined);
    assert.equal(JSON.stringify(listed.content).includes("body_base64"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publishing a Draft remains idempotent", async () => {
  const library = memoryLibrary();
  const service = new SkillAuthoringService(new MemoryDraftStore(), library);
  const candidate = await service.createDraft("renamed-review", "Renamed review skill");
  const published = await service.publishDraft(candidate.id, candidate.revision);
  const repeated = await service.publishDraft(published.id, published.revision);
  assert.equal(repeated.revision, published.revision);
  assert.match(
    Buffer.from(library.packages.get("renamed-review").files.find((file) => file.relativePath === "SKILL.md").body).toString("utf8"),
    /name: renamed-review/,
  );
});

test("Deleting a release restores its Draft as editable", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library);
  const candidate = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(candidate.id, candidate.revision);
  library.packages.delete(published.name);
  const restored = await service.restoreCandidateAfterReleaseDelete(published.name);
  assert.equal(restored.status, "draft");
  assert.equal(restored.revision, published.revision + 1);
  assert.equal(restored.published_at, null);
});

test("Published Skill Drafts delete without removing the released Skill", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library);
  const candidate = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(candidate.id, candidate.revision);

  assert.deepEqual(await service.deleteDraft(published.id), { id: published.id });
  await assert.rejects(service.getDraft(published.id), /does not exist/);
  assert.equal(library.packages.has(published.name), true);

  library.packages.delete(published.name);
  assert.equal(await service.restoreCandidateAfterReleaseDelete(published.name), null);
});

test("Authoring tools expose only the workspace draft workflow", () => {
  assert.deepEqual(SKILL_AUTHORING_TOOL_DESCRIPTORS.map((tool) => tool.name), [
    "list_skill_drafts",
    "get_skill_draft",
    "create_skill_draft",
    "publish_skill_draft",
  ]);
});

test("Skill source resources require absolute roots", () => {
  assert.throws(() => resolveBuiltinSkillSources([
    { pluginId: "bad", kind: "ragsystem.skill-source", value: "relative" },
  ]), /absolute path/);
});
