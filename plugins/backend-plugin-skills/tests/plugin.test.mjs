import assert from "node:assert/strict";
import fs from "node:fs";
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
  createSkillTools,
  createSkillsPlugin,
} from "../dist/index.js";

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
