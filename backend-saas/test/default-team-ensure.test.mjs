import assert from "node:assert/strict";
import test from "node:test";

import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";

import { buildDefaultTeamTemplate, ensureDefaultTeam } from "../dist/adapters/saas/composition/default-team.js";

class MemoryTeamStore {
  loaded = null;

  async loadTeams() {
    return this.loaded
      ? { activeTeam: this.loaded.activeTeam, teams: new Map(Array.from(this.loaded.teams, ([k, v]) => [k, new Map(v)])) }
      : null;
  }

  async saveAll(activeTeam, teams) {
    this.loaded = { activeTeam, teams: new Map(Array.from(teams, ([k, v]) => [k, new Map(v)])) };
  }

  async saveIndex() {}
  async removeTeam() {}
  async renameTeam() {}
  async getTeamLocation() { return null; }
}

test("SaaS product ensureDefaultTeam creates the default team from the product template on a fresh store", async () => {
  const store = new MemoryTeamStore();
  const agentConfig = new AgentConfigService(store);
  await agentConfig.initialize();

  assert.equal(await ensureDefaultTeam(agentConfig), true);
  const configs = agentConfig.listConfigs({ teamName: "default" });
  assert.deepEqual(
    Object.keys(configs).sort(),
    ["general_agent", "query_agent", "research_agent"],
  );
  assert.equal(configs.general_agent.default_entry, true);
  assert.ok(store.loaded, "ensure 创建必须经 applyTeamPayload 落盘");

  // 幂等：team 已存在（含用户改动）时 ensure 不再触碰。
  await agentConfig.createAgent({ agent_name: "my_agent", display_name: "My Agent" });
  assert.equal(await ensureDefaultTeam(agentConfig), false);
  assert.ok(agentConfig.getConfig("my_agent"));
  assert.ok(agentConfig.getConfig("research_agent"));
});

test("SaaS ensureDefaultTeam never touches a tenant-configured default team", async () => {
  const store = new MemoryTeamStore();
  const agentConfig = new AgentConfigService(store);
  await agentConfig.initialize();
  await agentConfig.applyTeamPayload("default", {
    my_entry: { agent_name: "my_entry", default_entry: true, tools: { enabled_tools: [] } },
  });

  assert.equal(await ensureDefaultTeam(agentConfig), false);
  assert.deepEqual(Object.keys(agentConfig.listConfigs({ teamName: "default" })), ["my_entry"]);
});

test("SaaS buildDefaultTeamTemplate entries pass the agent config schema", async () => {
  // 模板是产品数据：直接对 schema 校验，防止手改模板产生落盘即坏的配置。
  const { AgentConfigSchema } = await import("@ragsystem/backend-core/contracts/agent/agent-config.js");
  for (const [agentName, config] of Object.entries(buildDefaultTeamTemplate())) {
    AgentConfigSchema.parse({ ...config, agent_name: config.agent_name ?? agentName });
  }
});
