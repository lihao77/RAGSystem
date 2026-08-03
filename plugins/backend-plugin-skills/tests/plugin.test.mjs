import assert from "node:assert/strict";
import fs from "node:fs";
import Fastify from "fastify";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentConfigSchema } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BackgroundTaskService } from "@ragsystem/backend-core/services/runtime/background-task-service.js";
import {
  FilesystemSkillPackageStore,
  POSTGRES_SKILLS_MIGRATIONS,
  resolveArtifactStagingService,
  resolveBuiltinSkillSources,
  SkillToolService,
  SkillsAgentConfigService,
  SkillAuthoringService,
  SKILL_AUTHORING_TOOL_DESCRIPTORS,
  createSkillTools,
  createSkillsPlugin,
} from "../dist/index.js";
import { registerSkillRoutes } from "../dist/routes.js";

class MemoryConfigStore {
  rows = new Map();

  key(value) {
    return `${value.teamName}\0${value.agentName}`;
  }

  async get(key) {
    return this.rows.get(this.key(key)) ?? null;
  }

  async put(key, config) {
    this.rows.set(this.key(key), structuredClone(config));
  }

  async delete(key) {
    return this.rows.delete(this.key(key));
  }

  async purgeSkillReference(skillName) {
    const updated = [];
    for (const [key, config] of this.rows) {
      if (!config.enabled_skills.includes(skillName)) continue;
      config.enabled_skills = config.enabled_skills.filter((name) => name !== skillName);
      updated.push(key.replace("\0", "/"));
    }
    return updated;
  }
}

test("Skills config is isolated by team and agent and reset restores defaults", async () => {
  const service = new SkillsAgentConfigService(new MemoryConfigStore());
  await service.put({ teamName: "product", agentName: "writer" }, { enabled_skills: ["review-code"] });
  assert.deepEqual(
    await service.getEffective({ teamName: "product", agentName: "writer" }),
    { enabled_skills: ["review-code"] },
  );
  assert.deepEqual(
    await service.getEffective({ teamName: "default", agentName: "writer" }),
    { enabled_skills: [] },
  );
  assert.deepEqual(
    await service.delete({ teamName: "product", agentName: "writer" }),
    { enabled_skills: [] },
  );
});

test("Skills tools are absent when no Skill is enabled and expose three tools when enabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tools-"));
  try {
    const builtinRoot = path.join(root, "builtin");
    fs.mkdirSync(path.join(builtinRoot, "review-code"), { recursive: true });
    fs.writeFileSync(
      path.join(builtinRoot, "review-code", "SKILL.md"),
      "---\nname: review-code\ndescription: Review code\n---\nReview the code.\n",
    );
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: builtinRoot });
    const agent = { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} };
    assert.equal(createSkillTools({ skillTools: service, agent, config: { enabled_skills: [] } }).length, 0);
    assert.deepEqual(
      createSkillTools({ skillTools: service, agent, config: { enabled_skills: ["review-code"] } }).map((tool) => tool.name),
      ["activate_skill", "load_skill_resource", "execute_skill_script"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class MemoryDraftStore {
  rows = new Map();

  async list() {
    return [...this.rows.values()].map((draft) => structuredClone(draft));
  }

  async get(id) {
    const draft = this.rows.get(id);
    return draft ? structuredClone(draft) : null;
  }

  async create(draft) {
    this.rows.set(draft.id, structuredClone(draft));
  }

  async update(expectedRevision, draft) {
    const current = this.rows.get(draft.id);
    if (!current || current.revision !== expectedRevision) return false;
    this.rows.set(draft.id, structuredClone(draft));
    return true;
  }
}

class MemorySkillLibrary {
  skills = [];
  failCreate = false;

  async listSkills() {
    return structuredClone(this.skills);
  }

  async createSkill(input) {
    if (this.failCreate) throw new Error("create failed");
    if (this.skills.some((skill) => skill.name === input.name)) throw new Error("已存在");
    const skill = { ...input, source_type: "user_global" };
    this.skills.push(skill);
    return structuredClone(skill);
  }

  async deleteSkill(name) {
    const index = this.skills.findIndex((skill) => skill.name === name);
    if (index >= 0) this.skills.splice(index, 1);
    return { name, purged_agents: [] };
  }
}

test("Skill authoring owns revisions and publishes an immutable Skill package", async () => {
  const store = new MemoryDraftStore();
  const library = new MemorySkillLibrary();
  const service = new SkillAuthoringService(store, library);

  const created = await service.createDraft({
    name: "incident-response",
    description: "Respond to incidents",
    content: "## Triage\n\nCollect the facts first.",
  }, { sessionId: "session-1", agentName: "builder_orchestrator" });
  assert.equal(created.revision, 1);
  assert.equal(created.status, "draft");
  assert.equal(created.source_session_id, "session-1");
  assert.equal(created.source_agent_name, "builder_orchestrator");

  const updated = await service.updateDraft(created.id, 1, {
    name: created.name,
    description: "Respond to incidents safely",
    content: "## Triage\n\nCollect and verify the facts first.",
  });
  assert.equal(updated.revision, 2);
  await assert.rejects(
    service.updateDraft(created.id, 1, updated),
    (error) => error?.statusCode === 409 && /revision conflict/.test(error.message),
  );

  const published = await service.publishDraft(created.id, updated.revision);
  assert.equal(published.status, "published");
  assert.equal(published.revision, 3);
  assert.equal(library.skills[0].name, "incident-response");
  assert.equal(library.skills[0].content, updated.content);
  await assert.rejects(
    service.updateDraft(created.id, published.revision, updated),
    (error) => error?.statusCode === 409 && /immutable/.test(error.message),
  );
});

test("Skill publishing rejects an existing package and duplicate unpublished drafts", async () => {
  const store = new MemoryDraftStore();
  const library = new MemorySkillLibrary();
  const service = new SkillAuthoringService(store, library);
  await library.createSkill({ name: "existing-skill", description: "Existing", content: "Existing" });
  const draft = await service.createDraft({ name: "existing-skill", description: "New", content: "New" });
  await assert.rejects(
    service.publishDraft(draft.id, draft.revision),
    (error) => error?.statusCode === 409 && /already exists/.test(error.message),
  );
  await assert.rejects(
    service.createDraft({ name: "existing-skill", description: "Another", content: "Another" }),
    (error) => error?.statusCode === 409,
  );
});

test("Skills authoring tools are ordinary explicitly enabled tools, separate from Skill bindings", async () => {
  assert.deepEqual(
    SKILL_AUTHORING_TOOL_DESCRIPTORS.map((tool) => [tool.name, tool.implemented, tool.runtime_status]),
    [
      ["list_skill_drafts", true, "implemented"],
      ["get_skill_draft", true, "implemented"],
      ["create_skill_draft", true, "implemented"],
      ["update_skill_draft", true, "implemented"],
    ],
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-authoring-tools-"));
  try {
    const skillTools = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin") });
    const draftStore = new MemoryDraftStore();
    const authoring = new SkillAuthoringService(draftStore, new MemorySkillLibrary());
    const agentConfig = { async getEffective() { return { enabled_skills: [] }; } };
    const manager = new BackendPluginManager([createSkillsPlugin({
      runtimeFactory: async () => ({
        tools: skillTools,
        library: {},
        authoring,
        agentConfig,
      }),
    })]);
    await manager.register();
    const runtime = await manager.runtimeContributions().createRuntime({
      deploymentKind: "local",
      tenantId: "tenant-a",
      dataRoot: root,
      backgroundTasks: {},
      clientEvents: {},
    });
    try {
      const shared = {
        tenantId: "tenant-a",
        pathAccessPolicy: {},
        capabilities: runtime.capabilities,
      };
      const ordinary = await manager.runtimeContributions().createTools({
        ...shared,
        teamName: "default",
        agent: { agent_name: "worker", tools: { enabled_tools: ["create_skill_draft"] }, custom_params: {} },
      });
      assert.deepEqual(ordinary.map((tool) => tool.name), ["create_skill_draft"]);

      const builder = await manager.runtimeContributions().createTools({
        ...shared,
        teamName: "agent-builder",
        agent: {
          agent_name: "builder_orchestrator",
          tools: { enabled_tools: ["create_skill_draft", "list_skill_drafts"] },
          custom_params: {},
          tasks: { background: false },
        },
      });
      assert.deepEqual(builder.map((tool) => tool.name), ["list_skill_drafts", "create_skill_draft"]);
    } finally {
      runtime.dispose?.();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skill draft publishing is restricted to tenant administrators", async () => {
  const calls = [];
  const app = Fastify();
  let role = "member";
  const capability = {
    tools: { async listAvailableSkillsAsync() { return []; } },
    library: {
      async listSkills() { return []; },
      async getSkillDetail() { return {}; },
    },
    agentConfig: { async getEffective() { return { enabled_skills: [] }; } },
    authoring: {
      async listDrafts() { return []; },
      async getDraft() { return {}; },
      async createDraft() { return {}; },
      async updateDraft() { return {}; },
      async publishDraft(...args) { calls.push(args); return { id: "draft-1", status: "published" }; },
    },
  };
  app.addHook("onRequest", async (request) => {
    request.identity = { tenantId: "tenant-a", role };
    request.container = { pluginCapabilities: { require() { return capability; } } };
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error.statusCode ?? 500).send({ message: error.message });
  });
  await app.register(registerSkillRoutes);
  try {
    const forbidden = await app.inject({
      method: "POST",
      url: "/drafts/draft-1/publish",
      payload: { expected_revision: 1 },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.deepEqual(calls, []);

    role = "admin";
    const published = await app.inject({
      method: "POST",
      url: "/drafts/draft-1/publish",
      payload: { expected_revision: 1 },
    });
    assert.equal(published.statusCode, 200);
    assert.deepEqual(calls, [["draft-1", 1]]);
  } finally {
    await app.close();
  }
});

test("background Skill scripts use the task signal instead of the parent Run signal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-background-signal-"));
  const previousPython = process.env.RAGSYSTEM_PYTHON;
  try {
    const builtinRoot = path.join(root, "builtin");
    const skillRoot = path.join(builtinRoot, "long-skill");
    const scriptsRoot = path.join(skillRoot, "scripts");
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: long-skill\ndescription: Long running test\n---\nRun it.\n",
    );
    fs.writeFileSync(path.join(scriptsRoot, "wait.js"), "setTimeout(() => console.log('done'), 5000);\n");
    process.env.RAGSYSTEM_PYTHON = process.execPath;
    const backgroundTasks = new BackgroundTaskService();
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      backgroundTasks,
      skillIsolationMode: "shared",
    });
    const parentAbort = new AbortController();
    const result = await service.executeSkillScript(
      { skillName: "long-skill", scriptName: "wait.js", arguments: [], runInBackground: true },
      { sessionId: "session-a", runId: "run-a", taskId: "parent-task", signal: parentAbort.signal },
      { agent_name: "worker", default_entry: false, tasks: { background: true }, custom_params: {} },
      { enabled_skills: ["long-skill"] },
    );
    const taskId = result.content.task_id;
    assert.equal(taskId, result.content.background_task_id);
    assert.equal(backgroundTasks.getTaskSnapshot(taskId).cancel_supported, true);

    parentAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(backgroundTasks.getTaskSnapshot(taskId).status, "running");

    assert.equal(await backgroundTasks.cancelAndWait(taskId), true);
    assert.equal(backgroundTasks.getTaskSnapshot(taskId).status, "cancelled");
  } finally {
    if (previousPython === undefined) delete process.env.RAGSYSTEM_PYTHON;
    else process.env.RAGSYSTEM_PYTHON = previousPython;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Filesystem package store owns user Skill CRUD", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-store-"));
  try {
    const store = new FilesystemSkillPackageStore(root);
    await store.create({ name: "review-code", description: "Review code", content: "Start here." });
    await store.writeFile("review-code", "scripts/check.py", Buffer.from("print('ok')\n"));
    assert.deepEqual((await store.list()).map((item) => item.name), ["review-code"]);
    assert.equal((await store.listFiles("review-code")).some((item) => item.path === "scripts/check.py"), true);
    await store.updateMarkdown("review-code", { description: "Review code safely" });
    assert.equal((await store.get("review-code")).description, "Review code safely");
    assert.equal(await store.delete("review-code"), true);
    assert.equal(await store.get("review-code"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Postgres migrations include package and Agent config ownership", () => {
  const sql = POSTGRES_SKILLS_MIGRATIONS.map((migration) => migration.sql).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saas_skill_packages/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saas_skill_package_files/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS skill_agent_configs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saas_skill_drafts/);
});

test("plugin installation controls Skills route contribution", async () => {
  const absent = new BackendPluginManager();
  await absent.register();
  assert.equal(absent.routes("tenant").some((route) => route.prefix === "/api/skills"), false);

  const installed = new BackendPluginManager([createSkillsPlugin({
    runtimeFactory: async () => { throw new Error("runtime is not created during registration"); },
  })]);
  await installed.register();
  assert.equal(installed.routes("tenant").some((route) => route.prefix === "/api/skills"), true);
});

test("Skills interprets generic plugin resources and owns source validation", () => {
  const root = path.resolve("artifact-skills");
  assert.deepEqual(resolveBuiltinSkillSources([
    { pluginId: "artifact", kind: "unrelated", value: root },
    { pluginId: "artifact", kind: "ragsystem.skill-source", value: root },
  ]), [{ root, sourceLabel: "artifact" }]);
  assert.throws(
    () => resolveBuiltinSkillSources([{ pluginId: "bad", kind: "ragsystem.skill-source", value: "relative" }]),
    /must be an absolute path/,
  );
});

test("Skills resolves the Artifact staging resource per tenant", () => {
  const calls = [];
  const service = {};
  const provider = {
    forTenant(tenantId, dataRoot) {
      calls.push({ tenantId, dataRoot });
      return service;
    },
  };
  assert.equal(resolveArtifactStagingService([
    { pluginId: "artifacts", kind: "ragsystem.artifact-staging", value: provider },
  ], "tenant-a", "C:\\runtime"), service);
  assert.deepEqual(calls, [{ tenantId: "tenant-a", dataRoot: "C:\\runtime" }]);
});

test("Skill staged_file output is registered and replaced with an opaque ID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-staging-"));
  const previousPython = process.env.RAGSYSTEM_PYTHON;
  try {
    const builtinRoot = path.join(root, "builtin");
    const skillRoot = path.join(builtinRoot, "file-output");
    const scriptsRoot = path.join(skillRoot, "scripts");
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: file-output\ndescription: Create a file Artifact\n---\nCreate it.\n",
    );
    fs.writeFileSync(path.join(scriptsRoot, "create.py"), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const output = process.env.RAGSYSTEM_ARTIFACT_OUTPUT_DIR;",
      "if (!output) throw new Error('missing output directory');",
      "fs.writeFileSync(path.join(output, 'data.bin'), Buffer.from([1, 2, 3]));",
      "console.log(JSON.stringify({success:true,data:{title:'Demo'},artifact:{schema_version:2,kind:'data.binary',assets:[{asset_id:'data',role:'data',filename:'data.bin',media_type:'application/octet-stream',staged_file:'data.bin'}],presentations:[]}}));",
      "",
    ].join("\n"));
    const outputDirectory = path.join(root, "stage-output");
    let discarded = false;
    const artifactStaging = {
      async createRun(context) {
        assert.deepEqual(context, { sessionId: "session-a", runId: "run-a", toolCallId: "tool-a" });
        fs.mkdirSync(outputDirectory, { recursive: true });
        return { stageRunId: "stage-run-a", outputDirectory };
      },
      async registerOutputs(stageRunId, outputs) {
        assert.equal(stageRunId, "stage-run-a");
        assert.deepEqual(outputs, [{
          relativePath: "data.bin",
          filename: "data.bin",
          mediaType: "application/octet-stream",
        }]);
        assert.equal(fs.existsSync(path.join(outputDirectory, "data.bin")), true);
        return [{
          stagedFileId: "stage_opaque",
          filename: "data.bin",
          mediaType: "application/octet-stream",
          size: 3,
          sha256: "0".repeat(64),
        }];
      },
      async discardRun() { discarded = true; },
    };
    process.env.RAGSYSTEM_PYTHON = process.execPath;
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      artifactStaging,
      skillIsolationMode: "shared",
    });
    const result = await service.executeSkillScript(
      { skillName: "file-output", scriptName: "create.py", arguments: [] },
      { sessionId: "session-a", runId: "run-a", toolCallId: "tool-a" },
      { agent_name: "worker", default_entry: false, tasks: { background: false }, custom_params: {} },
      { enabled_skills: ["file-output"] },
    );
    assert.equal(result.success, true);
    assert.equal(result.content.artifact.assets[0].staged_file_id, "stage_opaque");
    assert.equal(Object.hasOwn(result.content.artifact.assets[0], "staged_file"), false);
    assert.equal(result.metadata.staged_file_count, 1);
    assert.equal(discarded, false);
  } finally {
    if (previousPython === undefined) delete process.env.RAGSYSTEM_PYTHON;
    else process.env.RAGSYSTEM_PYTHON = previousPython;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("core AgentConfig strips legacy Skills config", () => {
  const parsed = AgentConfigSchema.parse({
    agent_name: "writer",
    skills: { enabled_skills: ["review-code"] },
  });
  assert.equal(Object.hasOwn(parsed, "skills"), false);
});
