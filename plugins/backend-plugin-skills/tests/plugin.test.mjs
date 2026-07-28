import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentConfigSchema } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  FilesystemSkillPackageStore,
  POSTGRES_SKILLS_MIGRATIONS,
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

test("core AgentConfig strips legacy Skills config", () => {
  const parsed = AgentConfigSchema.parse({
    agent_name: "writer",
    skills: { enabled_skills: ["review-code"] },
  });
  assert.equal(Object.hasOwn(parsed, "skills"), false);
});
