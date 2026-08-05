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
  SKILL_SOURCE_RESOURCE,
} from "../dist/index.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";

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
    async getPublishedSkillBundle(name) { return structuredClone(packages.get(name) ?? null); },
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
    assert.equal(first.draft.revision, draft.revision + 1);

    const repeated = await service.publishWorkspaceDraft(draft.id, root);
    assert.equal(repeated.published, true);
    assert.equal(repeated.draft.revision, first.draft.revision);

    fs.writeFileSync(
      path.join(local.workspacePath, "SKILL.md"),
      "---\nname: workspace-skill\ndescription: Workspace Skill\n---\nUpdated reusable instructions.\n",
    );
    const second = await service.publishWorkspaceDraft(draft.id, root);
    assert.equal(second.published, true);
    assert.equal(second.draft.revision, first.draft.revision + 1);
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

test("a saved Draft can return to published when its Skill package already matches", async () => {
  const library = memoryLibrary();
  const service = new SkillAuthoringService(new MemoryDraftStore(), library);
  const candidate = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(candidate.id, candidate.revision);
  const saved = await service.updateDraft(published.id, published.revision, {
    name: published.name,
    description: published.description,
    content: published.content,
  });
  assert.equal(saved.status, "draft");

  const republished = await service.publishDraft(saved.id, saved.revision);
  assert.equal(republished.status, "published");
  assert.equal(republished.revision, saved.revision + 1);
  assert.equal(library.packages.has("review-code"), true);
});

test("an administrator can edit and republish a published Skill Draft", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-draft-admin-edit-"));
  try {
    const store = new MemoryDraftStore();
    const library = memoryLibrary();
    const service = new SkillAuthoringService(store, library);
    const created = await service.createDraft("review-code", "Review code");
    const local = await service.materializeDraftToWorkspace(created, root);
    fs.mkdirSync(path.join(local.workspacePath, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(local.workspacePath, "SKILL.md"),
      "---\nname: review-code\ndescription: Review code\nlicense: MIT\nmetadata:\n  custom_flag: true\n---\nReview the code.\n",
    );
    fs.writeFileSync(path.join(local.workspacePath, "scripts", "check.py"), "print('ok')\n");
    const synchronized = await service.publishWorkspaceDraft(created.id, root);
    const published = await service.publishDraft(synchronized.draft.id, synchronized.draft.revision);

    const updated = await service.updateDraft(published.id, published.revision, {
      name: published.name,
      description: "Review code carefully",
      content: "Use the updated review workflow.",
    });
    assert.equal(updated.status, "draft");
    assert.equal(updated.revision, published.revision + 1);
    assert.equal(updated.published_at, published.published_at);
    assert.match(library.packages.get("review-code").content, /Review the code/);
    assert.ok(updated.bundle_assets.some((asset) => asset.relative_path === "scripts/check.py"));
    const markdown = Buffer.from(
      updated.bundle_assets.find((asset) => asset.relative_path === "SKILL.md").body_base64,
      "base64",
    ).toString("utf8");
    assert.match(markdown, /license: MIT/);
    assert.match(markdown, /custom_flag: true/);
    assert.match(markdown, /Use the updated review workflow/);

    const republished = await service.publishDraft(updated.id, updated.revision);
    assert.equal(republished.status, "published");
    assert.equal(republished.revision, updated.revision + 1);
    assert.match(library.packages.get("review-code").content, /Use the updated review workflow/);
    await assert.rejects(
      service.updateDraft(republished.id, republished.revision, {
        name: "renamed-review",
        description: republished.description,
        content: republished.content,
      }),
      /names are immutable/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("administrator edits auto-publish with one Skill Draft revision", async () => {
  const library = memoryLibrary();
  const service = new SkillAuthoringService(
    new MemoryDraftStore(),
    library,
    { getSection: (key) => key === "skills" ? { approval: { auto_publish_candidates: true } } : undefined },
  );
  const created = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(created.id, created.revision);
  const updated = await service.updateDraft(published.id, published.revision, {
    name: published.name,
    description: published.description,
    content: "Automatically published instructions.",
  });

  assert.equal(updated.status, "published");
  assert.equal(updated.revision, published.revision + 1);
  assert.match(library.packages.get("review-code").content, /Automatically published instructions/);
});

test("administrator can edit complete Skill Draft bundle files", async () => {
  const service = new SkillAuthoringService(new MemoryDraftStore(), memoryLibrary());
  const created = await service.createDraft("review-code", "Review code");

  const withScript = await service.putDraftFile(created.id, created.revision, {
    relative_path: "scripts/check.py",
    media_type: "text/x-python; charset=utf-8",
    body_base64: Buffer.from("print('ok')\n").toString("base64"),
  });
  assert.equal(withScript.revision, created.revision + 1);
  assert.equal((await service.getDraftFile(withScript.id, "scripts/check.py")).size, 12);

  const updatedMarkdown = [
    "---",
    "name: review-code",
    "description: Review code carefully",
    "metadata:",
    "  custom_flag: true",
    "---",
    "Use the browser editor.",
    "",
  ].join("\n");
  const withMarkdown = await service.putDraftFile(withScript.id, withScript.revision, {
    relative_path: "SKILL.md",
    media_type: "text/markdown; charset=utf-8",
    body_base64: Buffer.from(updatedMarkdown).toString("base64"),
  });
  assert.equal(withMarkdown.description, "Review code carefully");
  assert.equal(withMarkdown.content, "Use the browser editor.");
  assert.equal(withMarkdown.skill_metadata.custom_flag, true);

  const withoutScript = await service.deleteDraftFile(withMarkdown.id, withMarkdown.revision, "scripts/check.py");
  assert.equal(withoutScript.bundle_assets.some((asset) => asset.relative_path === "scripts/check.py"), false);
  await assert.rejects(
    service.deleteDraftFile(withoutScript.id, withoutScript.revision, "SKILL.md"),
    /must contain root-level SKILL.md/,
  );
});

test("invalid Skill Draft file mutations never synchronize the Draft", async () => {
  const service = new SkillAuthoringService(new MemoryDraftStore(), memoryLibrary());
  const created = await service.createDraft("review-code", "Review code");

  await assert.rejects(
    service.putDraftFile(created.id, created.revision, {
      relative_path: "../escape.py",
      body_base64: Buffer.from("bad").toString("base64"),
    }),
    /Invalid Skill file path/,
  );
  await assert.rejects(
    service.putDraftFile(created.id, created.revision, {
      relative_path: "SKILL.md",
      body_base64: Buffer.from("---\nname: INVALID\ndescription: Broken\n---\nBody\n").toString("base64"),
    }),
  );
  const unchanged = await service.getDraft(created.id);
  assert.equal(unchanged.revision, created.revision);
  assert.equal(unchanged.bundle_assets.length, 1);
});

test("Deleting a published Skill restores its Draft as editable", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library);
  const candidate = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(candidate.id, candidate.revision);
  library.packages.delete(published.name);
  const restored = await service.restoreDraftAfterSkillDelete(published.name);
  assert.equal(restored.status, "draft");
  assert.equal(restored.revision, published.revision + 1);
  assert.equal(restored.published_at, null);
});

test("Published Skill Drafts delete without removing the published Skill", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library);
  const candidate = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(candidate.id, candidate.revision);

  assert.deepEqual(await service.deleteDraft(published.id), { id: published.id });
  await assert.rejects(service.getDraft(published.id), /does not exist/);
  assert.equal(library.packages.has(published.name), true);

  library.packages.delete(published.name);
  assert.equal(await service.restoreDraftAfterSkillDelete(published.name), null);
});

test("a deleted published Skill Draft is rebuilt from its complete package", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library);
  const created = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(created.id, created.revision);
  library.packages.get("review-code").files.push({
    relativePath: "scripts/check.py",
    mediaType: "text/x-python; charset=utf-8",
    body: Buffer.from("print('ok')\n"),
  });
  await service.deleteDraft(published.id);

  const restored = await service.ensureDraftForPublishedSkill("review-code");
  assert.notEqual(restored.id, published.id);
  assert.equal(restored.status, "published");
  assert.equal(restored.revision, 1);
  assert.ok(restored.published_at);
  assert.ok(restored.bundle_assets.some((asset) => asset.relative_path === "SKILL.md"));
  assert.ok(restored.bundle_assets.some((asset) => asset.relative_path === "scripts/check.py"));
  assert.equal((await service.ensureDraftForPublishedSkill("review-code")).id, restored.id);

  const updated = await service.updateDraft(restored.id, restored.revision, {
    name: restored.name,
    description: restored.description,
    content: "Continue updating after Draft reconstruction.",
  });
  const republished = await service.publishDraft(updated.id, updated.revision);
  assert.equal(republished.status, "published");
  assert.match(library.packages.get("review-code").content, /Continue updating/);
  assert.ok(library.packages.get("review-code").files.some((file) => file.relativePath === "scripts/check.py"));
});

test("createDraftForEditing restores a same-name published Skill without a Draft", async () => {
  const store = new MemoryDraftStore();
  const library = memoryLibrary();
  const service = new SkillAuthoringService(store, library);
  const created = await service.createDraft("review-code", "Review code");
  const published = await service.publishDraft(created.id, created.revision);
  await service.deleteDraft(published.id);

  const restored = await service.createDraftForEditing("review-code", "Ignored scaffold description");
  assert.equal(restored.status, "published");
  assert.equal(restored.description, published.description);
  assert.equal(restored.content, published.content);
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
    provideBackendResource(SKILL_SOURCE_RESOURCE, "relative", "bad"),
  ]), /absolute path/);
});
