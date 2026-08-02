import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  AgentBuilderConflictError,
  AgentBuilderService,
  AgentBuilderValidationError,
  FilesystemAgentBuilderStore,
  AGENT_BUILDER_TEAM_NAME,
  createAgentBuilderPlugin,
  validateBlueprint,
} from "../dist/index.js";

class MemoryTeamStore {
  loaded = null;

  async loadTeams() {
    return this.loaded ? cloneLoaded(this.loaded) : null;
  }

  async saveAll(activeTeam, teams) {
    this.loaded = { activeTeam, teams: cloneTeams(teams) };
  }

  async saveIndex(activeTeam, teams) {
    this.loaded = { activeTeam, teams: cloneTeams(teams) };
  }

  async removeTeam(teamName) {
    this.loaded?.teams.delete(teamName);
  }

  async renameTeam(teamName, newTeamName) {
    const current = this.loaded?.teams.get(teamName);
    if (!current || !this.loaded) return;
    this.loaded.teams.delete(teamName);
    this.loaded.teams.set(newTeamName, current);
  }

  async getTeamLocation(teamName) {
    return `memory://${teamName}`;
  }
}

class MemoryBindings {
  skills = new Map();
  mcp = new Map();
  failMcpWrite = false;
  inventory = {
    tools: new Set(["read_file", "write_file"]),
    skills: new Set(["review-code"]),
    mcpServers: new Set(["github"]),
  };

  key(teamName, agentName) { return `${teamName}/${agentName}`; }
  async getSkillConfig(teamName, agentName) { return [...(this.skills.get(this.key(teamName, agentName)) ?? [])]; }
  async putSkillConfig(teamName, agentName, names) { this.skills.set(this.key(teamName, agentName), [...names]); }
  async getMcpConfig(teamName, agentName) { return [...(this.mcp.get(this.key(teamName, agentName)) ?? [])]; }
  async putMcpConfig(teamName, agentName, names) {
    if (this.failMcpWrite && names.length > 0) throw new Error("MCP write failed");
    this.mcp.set(this.key(teamName, agentName), [...names]);
  }
}

test("validation rejects missing capabilities and delegation cycles", () => {
  const report = validateBlueprint(blueprint({
    agents: [
      agent("lead", { tools: ["missing"], delegates: ["worker"] }),
      agent("worker", { delegates: ["lead"] }),
    ],
  }), {
    tools: new Set(["read_file"]),
    skills: new Set(),
    mcpServers: new Set(),
  });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "unknown_tool"));
  assert.ok(report.issues.some((issue) => issue.code === "delegation_cycle"));
});

test("publishing creates an immutable release and materializes Team bindings", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const draft = await fixture.service.createDraft(blueprint());
    const ready = await fixture.service.validateDraft(draft.id, bindings.inventory);
    assert.equal(ready.status, "ready");

    const release = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    assert.equal(release.version, 1);
    assert.equal(release.runtime_team_name, "support-team--v1");
    assert.equal((await fixture.service.getDraft(draft.id)).status, "published");
    assert.deepEqual(Object.keys(fixture.agentConfig.listConfigs({ teamName: "support-team--v1" })).sort(), ["lead", "worker"]);
    assert.deepEqual(bindings.skills.get("support-team--v1/lead"), ["review-code"]);
    assert.deepEqual(bindings.mcp.get("support-team--v1/lead"), ["github"]);

    const repeated = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    assert.equal(repeated.id, release.id);
    assert.equal((await fixture.service.listReleases("support-team")).length, 1);
    await assert.rejects(
      fixture.service.updateDraft(draft.id, draft.revision, blueprint({ description: "Changed" })),
      AgentBuilderConflictError,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a second published draft increments the release version", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const first = await fixture.service.createDraft(blueprint());
    const release1 = await fixture.service.publishDraft(first.id, first.revision, bindings);
    const second = await fixture.service.createDraft(blueprint({ description: "Second release" }));
    const release2 = await fixture.service.publishDraft(second.id, second.revision, bindings);
    assert.equal(release1.version, 1);
    assert.equal(release2.version, 2);
    assert.equal(release2.runtime_team_name, "support-team--v2");
    assert.notEqual(release1.id, release2.id);
  } finally {
    fixture.cleanup();
  }
});

test("publishing never overwrites an existing version Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    await fixture.agentConfig.createTeam("support-team--v1");
    const draft = await fixture.service.createDraft(blueprint());

    await assert.rejects(
      fixture.service.publishDraft(draft.id, draft.revision, bindings),
      AgentBuilderConflictError,
    );

    assert.equal((await fixture.service.listReleases()).length, 0);
    assert.equal((await fixture.service.getDraft(draft.id)).status, "draft");
    assert.equal(
      (await fixture.agentConfig.listTeams()).teams.some((team) => team.team_name === "support-team--v1"),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test("failed materialization does not create a release or leave a Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    bindings.failMcpWrite = true;
    const draft = await fixture.service.createDraft(blueprint());
    await assert.rejects(
      fixture.service.publishDraft(draft.id, draft.revision, bindings),
      /MCP write failed/,
    );
    assert.equal((await fixture.service.listReleases()).length, 0);
    assert.equal((await fixture.agentConfig.listTeams()).teams.some((team) => team.team_name === "support-team--v1"), false);
    assert.equal((await fixture.service.getDraft(draft.id)).status, "draft");
  } finally {
    fixture.cleanup();
  }
});

test("invalid drafts cannot be published", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const invalid = blueprint({ agents: [agent("lead", { tools: ["missing"] })] });
    const draft = await fixture.service.createDraft(invalid);
    await assert.rejects(
      fixture.service.publishDraft(draft.id, draft.revision, bindings),
      AgentBuilderValidationError,
    );
    assert.equal((await fixture.service.getDraft(draft.id)).status, "validation_failed");
  } finally {
    fixture.cleanup();
  }
});

test("plugin contributes the Builder route only when installed", async () => {
  const absent = new BackendPluginManager();
  await absent.register();
  assert.equal(absent.routes("tenant").some((route) => route.prefix === "/api/agent-builder"), false);

  const mcp = { manifest: { id: "@ragsystem/backend-plugin-mcp", version: "0.1.0" }, register() {} };
  const skills = { manifest: { id: "@ragsystem/backend-plugin-skills", version: "0.1.0" }, register() {} };
  const installed = new BackendPluginManager([mcp, skills, createAgentBuilderPlugin()]);
  await installed.register();
  assert.equal(installed.routes("tenant").some((route) => route.prefix === "/api/agent-builder"), true);
});

test("plugin seeds an activatable Builder Team without changing the active Team", async () => {
  const fixture = await createFixture();
  try {
    await fixture.agentConfig.createTeam("workspace");
    await fixture.agentConfig.activateTeam("workspace");
    const manager = installedAgentBuilderManager();
    await manager.register();

    const runtime = await manager.runtimeContributions().createRuntime(runtimeContext(fixture));
    try {
      const summary = await fixture.agentConfig.listTeams();
      const builder = summary.teams.find((team) => team.team_name === AGENT_BUILDER_TEAM_NAME);
      assert.equal(summary.active_team, "workspace");
      assert.ok(builder);
      assert.deepEqual(builder.agents.sort(), [
        "agent_architect",
        "agent_evaluator",
        "agent_optimizer",
        "builder_orchestrator",
        "capability_researcher",
        "requirements_researcher",
      ]);

      const configs = fixture.agentConfig.listConfigs({ teamName: AGENT_BUILDER_TEAM_NAME });
      assert.equal(configs.builder_orchestrator.default_entry, true);
      assert.deepEqual(
        configs.builder_orchestrator.delegation.enabled_agents.slice().sort(),
        [
          "agent_architect",
          "agent_evaluator",
          "agent_optimizer",
          "capability_researcher",
          "requirements_researcher",
        ],
      );
      for (const target of configs.builder_orchestrator.delegation.enabled_agents) {
        assert.ok(configs[target], `missing delegated Agent ${target}`);
      }
    } finally {
      runtime.dispose();
    }
  } finally {
    fixture.cleanup();
  }
});

test("plugin preserves an existing Builder Team instead of overwriting it", async () => {
  const fixture = await createFixture();
  try {
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, {
      preserved_entry: {
        agent_name: "preserved_entry",
        display_name: "User Customized Builder",
        description: "keep this customization",
        enabled: true,
        default_entry: true,
        llm_tiers: null,
        tools: { enabled_tools: [] },
        goals: { enabled: false },
        tasks: { background: false },
        delegation: { enabled_agents: [] },
        custom_params: { user_customized: true },
      },
    });
    const manager = installedAgentBuilderManager();
    await manager.register();
    const runtime = await manager.runtimeContributions().createRuntime(runtimeContext(fixture));
    try {
      const configs = fixture.agentConfig.listConfigs({ teamName: AGENT_BUILDER_TEAM_NAME });
      assert.deepEqual(Object.keys(configs), ["preserved_entry"]);
      assert.equal(configs.preserved_entry.custom_params.user_customized, true);
    } finally {
      runtime.dispose();
    }
  } finally {
    fixture.cleanup();
  }
});

test("Builder-only draft tools are visible only to the Builder entry Agent", async () => {
  const fixture = await createFixture();
  try {
    const manager = installedAgentBuilderManager();
    await manager.register();
    const runtime = await manager.runtimeContributions().createRuntime(runtimeContext(fixture));
    try {
      const builderAgent = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
      const ordinaryAgent = fixture.agentConfig.getConfig("orchestrator_agent", { teamName: "default" });
      const shared = {
        tenantId: "tenant-test",
        pathAccessPolicy: {},
        capabilities: runtime.capabilities,
      };
      const builderTools = await manager.runtimeContributions().createTools({
        ...shared,
        teamName: AGENT_BUILDER_TEAM_NAME,
        agent: builderAgent,
      });
      const ordinaryTools = await manager.runtimeContributions().createTools({
        ...shared,
        teamName: "default",
        agent: ordinaryAgent,
      });
      assert.deepEqual(builderTools.map((tool) => tool.name).sort(), [
        "create_agent_draft",
        "get_agent_draft",
        "list_agent_drafts",
        "update_agent_draft",
      ]);
      assert.deepEqual(ordinaryTools, []);

      const byName = new Map(builderTools.map((tool) => [tool.name, tool]));
      const created = await byName.get("create_agent_draft").call({ blueprint: blueprint() }, {});
      assert.equal(created.success, true);
      assert.equal(created.content.revision, 1);

      const loaded = await byName.get("get_agent_draft").call({ draft_id: created.content.id }, {});
      assert.equal(loaded.success, true);
      assert.equal(loaded.content.id, created.content.id);

      const updated = await byName.get("update_agent_draft").call({
        draft_id: created.content.id,
        expected_revision: 1,
        blueprint: blueprint({ description: "Updated by the Builder Team" }),
      }, {});
      assert.equal(updated.success, true);
      assert.equal(updated.content.revision, 2);

      const listed = await byName.get("list_agent_drafts").call({}, {});
      assert.equal(listed.success, true);
      assert.equal(listed.content.length, 1);
      assert.equal(listed.content[0].revision, 2);
    } finally {
      runtime.dispose();
    }
  } finally {
    fixture.cleanup();
  }
});

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-builder-"));
  const agentConfig = new AgentConfigService(new MemoryTeamStore());
  await agentConfig.initialize();
  return {
    root,
    agentConfig,
    service: new AgentBuilderService(new FilesystemAgentBuilderStore(root), agentConfig),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function blueprint(overrides = {}) {
  return {
    schema_version: 1,
    name: "support-team",
    description: "Resolve customer support requests",
    entry_agent: "lead",
    agents: [
      agent("lead", {
        tools: ["read_file"],
        skills: ["review-code"],
        mcp_servers: ["github"],
        delegates: ["worker"],
      }),
      agent("worker", { tools: ["write_file"] }),
    ],
    acceptance_tests: [{ name: "basic", input: "Resolve ticket 42", expected_contains: ["42"] }],
    ...overrides,
  };
}

function agent(name, overrides = {}) {
  return {
    name,
    description: `${name} agent`,
    instructions: `You are the ${name} agent.`,
    tools: [],
    skills: [],
    mcp_servers: [],
    delegates: [],
    ...overrides,
  };
}

function cloneTeams(teams) {
  return new Map([...teams].map(([teamName, agents]) => [
    teamName,
    new Map([...agents].map(([agentName, config]) => [agentName, structuredClone(config)])),
  ]));
}

function cloneLoaded(value) {
  return { activeTeam: value.activeTeam, teams: cloneTeams(value.teams) };
}

function installedAgentBuilderManager() {
  const mcp = { manifest: { id: "@ragsystem/backend-plugin-mcp", version: "0.1.0" }, register() {} };
  const skills = { manifest: { id: "@ragsystem/backend-plugin-skills", version: "0.1.0" }, register() {} };
  return new BackendPluginManager([mcp, skills, createAgentBuilderPlugin()]);
}

function runtimeContext(fixture) {
  return {
    deploymentKind: "local",
    tenantId: "tenant-test",
    dataRoot: fixture.root,
    agentConfig: fixture.agentConfig,
  };
}
