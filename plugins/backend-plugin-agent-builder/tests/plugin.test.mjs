import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_CONFIG_CHANGED_EVENT } from "@ragsystem/backend-core/contracts/agent/agent-config-events.js";
import { CapabilityRegistry, provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { MCP_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-mcp/capability.js";
import { SKILLS_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-skills/capability.js";

import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  AgentBuilderConflictError,
  AgentBuilderService,
  AgentBuilderValidationError,
  AGENT_BUILDER_RUNTIME_CAPABILITY,
  FilesystemAgentBuilderStore,
  AGENT_BUILDER_TEAM_NAME,
  buildAgentBuilderTeam,
  createAgentBuilderPlugin,
  createAgentBuilderTools,
  ensureAgentBuilderTeam,
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
    if (this.failMcpWrite && names.length > 0) {
      this.failMcpWrite = false;
      throw new Error("MCP write failed");
    }
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

test("publishing materializes the Draft as a same-name Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const draft = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    assert.equal(published.status, "published");
    assert.equal(published.revision, draft.revision + 1);
    assert.equal(published.source_team_name, "support-team");
    assert.ok(published.published_at);
    assert.deepEqual(Object.keys(fixture.agentConfig.listConfigs({ teamName: "support-team" })).sort(), ["lead", "worker"]);
    assert.deepEqual(bindings.skills.get("support-team/lead"), ["review-code"]);
    assert.deepEqual(bindings.mcp.get("support-team/lead"), ["github"]);

    const repeated = await fixture.service.publishDraft(draft.id, published.revision, bindings);
    assert.equal(repeated.id, published.id);
    assert.equal(repeated.revision, published.revision);
    assert.equal((await fixture.agentConfig.listTeams()).teams.filter((team) => team.team_name === "support-team").length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("auto approval publishes a valid Agent draft without activating its Team", async () => {
  const fixture = await createFixture([], {
    getSection: (key) => key === "agent_builder"
      ? { approval: { auto_publish_candidates: true } }
      : undefined,
  });
  try {
    const bindings = new MemoryBindings();
    const draft = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.autoApproveDraft(draft, async () => bindings);
    assert.equal(published.status, "published");
    assert.equal(published.source_team_name, "support-team");
    assert.ok(published.published_at);
    assert.equal((await fixture.agentConfig.listTeams()).active_team, "default");
  } finally {
    fixture.cleanup();
  }
});

test("an edited published Draft updates the same Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const first = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.publishDraft(first.id, first.revision, bindings);
    const edited = await fixture.service.updateDraft(published.id, published.revision, blueprint({
      description: "Updated Team",
      agents: [
        agent("lead", { description: "Updated lead", tools: ["read_file"], skills: ["review-code"], mcp_servers: ["github"], delegates: ["worker"] }),
        agent("worker", { description: "Worker" }),
      ],
    }));
    assert.equal(edited.id, first.id);
    assert.equal(edited.status, "draft");
    assert.equal(edited.source_team_name, "support-team");

    const republished = await fixture.service.publishDraft(edited.id, edited.revision, bindings);
    assert.equal(republished.id, first.id);
    assert.equal(republished.status, "published");
    assert.equal(republished.source_team_name, "support-team");
    assert.equal(fixture.agentConfig.getConfig("lead", { teamName: "support-team" }).description, "Updated lead");
    assert.equal((await fixture.agentConfig.listTeams()).teams.filter((team) => team.team_name === "support-team").length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("failed republish restores the existing Team configuration", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const draft = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    const originalConfig = fixture.agentConfig.getConfig("lead", { teamName: "support-team" });
    const edited = await fixture.service.updateDraft(published.id, published.revision, blueprint({
      agents: [
        agent("lead", { description: "Must roll back", tools: ["read_file"], skills: ["review-code"], mcp_servers: ["github"], delegates: ["worker"] }),
        agent("worker", { description: "Worker" }),
      ],
    }));
    bindings.failMcpWrite = true;

    await assert.rejects(
      fixture.service.publishDraft(edited.id, edited.revision, bindings),
      /MCP write failed/,
    );

    const liveConfig = fixture.agentConfig.getConfig("lead", { teamName: "support-team" });
    assert.equal(liveConfig.description, originalConfig.description);
    assert.deepEqual(await bindings.getMcpConfig("support-team", "lead"), ["github"]);
    const unchanged = await fixture.service.getDraft(edited.id);
    assert.equal(unchanged.status, "draft");
    assert.equal(unchanged.revision, edited.revision);
  } finally {
    fixture.cleanup();
  }
});

test("a new Draft never overwrites an existing Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    await fixture.agentConfig.createTeam("support-team");
    const draft = await fixture.service.createDraft(blueprint());

    await assert.rejects(
      fixture.service.publishDraft(draft.id, draft.revision, bindings),
      AgentBuilderConflictError,
    );

    assert.equal((await fixture.service.getDraft(draft.id)).status, "draft");
    assert.equal(
      (await fixture.agentConfig.listTeams()).teams.some((team) => team.team_name === "support-team"),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test("failed materialization does not publish the Draft or leave a Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    bindings.failMcpWrite = true;
    const draft = await fixture.service.createDraft(blueprint());
    await assert.rejects(
      fixture.service.publishDraft(draft.id, draft.revision, bindings),
      /MCP write failed/,
    );
    assert.equal((await fixture.agentConfig.listTeams()).teams.some((team) => team.team_name === "support-team"), false);
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
    const unchanged = await fixture.service.getDraft(draft.id);
    assert.equal(unchanged.status, "draft");
    assert.equal(unchanged.revision, draft.revision);
  } finally {
    fixture.cleanup();
  }
});

test("manual Team snapshots create one linked Draft and update it idempotently", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    await fixture.agentConfig.createTeam("copied-team");
    await fixture.agentConfig.copyAgentsToTeam("copied-team", "default", ["general_agent"]);
    await bindings.putSkillConfig("copied-team", "general_agent", ["review-code"]);
    await bindings.putMcpConfig("copied-team", "general_agent", ["github"]);

    const created = await fixture.service.synchronizeTeamDraft("copied-team", bindings);
    assert.ok(created);
    assert.equal(created.status, "published");
    assert.equal(created.source_team_name, "copied-team");
    assert.equal(created.blueprint.entry_agent, "general_agent");
    assert.deepEqual(created.blueprint.agents[0].skills, ["review-code"]);
    assert.deepEqual(created.blueprint.agents[0].mcp_servers, ["github"]);

    await fixture.agentConfig.activateTeam("copied-team");
    await fixture.agentConfig.patchConfig("general_agent", { description: "Edited manually" });
    const updated = await fixture.service.synchronizeTeamDraft("copied-team", bindings);
    assert.equal(updated.id, created.id);
    assert.equal(updated.status, "published");
    assert.equal(updated.revision, created.revision + 1);
    assert.equal(updated.blueprint.agents[0].description, "Edited manually");
    assert.equal(updated.validation, null);

    const unchanged = await fixture.service.synchronizeTeamDraft("copied-team", bindings);
    assert.equal(unchanged.id, updated.id);
    assert.equal(unchanged.revision, updated.revision);
    assert.equal((await fixture.service.listDrafts()).length, 1);

    await fixture.agentConfig.renameTeam("copied-team", "renamed-team");
    const renamed = await fixture.service.synchronizeTeamDraft(
      "renamed-team",
      bindings,
      { previousTeamName: "copied-team" },
    );
    assert.equal(renamed.id, created.id);
    assert.equal(renamed.status, "published");
    assert.equal(renamed.source_team_name, "renamed-team");
    assert.equal(renamed.blueprint.name, "renamed-team");
    assert.equal((await fixture.service.listDrafts()).length, 1);
    const repeated = await fixture.service.publishDraft(renamed.id, renamed.revision, bindings);
    assert.equal(repeated.id, renamed.id);
    assert.equal(repeated.revision, renamed.revision);
  } finally {
    fixture.cleanup();
  }
});

test("editing a published Team updates the same published Draft without losing config", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    bindings.inventory = {};
    const first = await fixture.service.createDraft(blueprint({
      entry_agent: "lead",
      agents: [agent("lead", {
        instructions: "Keep this prompt.",
        enabled: false,
        display_name: null,
        llm_tiers: {
          default: { model_name: "default-model" },
          fast: { model_name: "fast-model", temperature: 0.2 },
        },
        custom_params: {
          behavior: { system_prompt: "Keep this prompt.", preserve_recent_turns: 9 },
          extension_setting: "preserved",
        },
      })],
    }));
    const published = await fixture.service.publishDraft(first.id, first.revision, bindings);
    assert.equal(published.status, "published");
    assert.equal(published.source_team_name, "support-team");
    const liveConfig = fixture.agentConfig.getConfig("lead", { teamName: "support-team" });
    assert.equal(liveConfig.enabled, false);
    assert.equal(liveConfig.display_name, null);
    assert.equal(liveConfig.llm_tiers.fast.model_name, "fast-model");
    assert.equal(liveConfig.custom_params.extension_setting, "preserved");
    assert.equal(liveConfig.custom_params.behavior.preserve_recent_turns, 9);
    assert.equal(liveConfig.custom_params.behavior.system_prompt, "Keep this prompt.");

    await fixture.agentConfig.activateTeam("support-team");
    await fixture.agentConfig.patchConfig("lead", { description: "Edited while live" });
    const next = await fixture.service.synchronizeTeamDraft("support-team", bindings);
    assert.equal(next.id, first.id);
    assert.equal(next.status, "published");
    assert.equal(next.source_team_name, "support-team");
    assert.equal(next.blueprint.name, "support-team");
    assert.equal(next.blueprint.agents[0].description, "Edited while live");
    assert.equal(next.blueprint.agents[0].llm_tiers.fast.model_name, "fast-model");
    assert.equal(next.blueprint.agents[0].custom_params.extension_setting, "preserved");

    const unchanged = await fixture.service.synchronizeTeamDraft("support-team", bindings);
    assert.equal(unchanged.id, next.id);
    assert.equal(unchanged.revision, next.revision);
    assert.equal((await fixture.service.listDrafts()).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("Agent Drafts delete independently and Team deletion restores Drafts that still exist", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const removable = await fixture.service.createDraft(blueprint());
    assert.deepEqual(await fixture.service.deleteDraft(removable.id), { id: removable.id });
    await assert.rejects(fixture.service.getDraft(removable.id), /does not exist/);

    const published = await fixture.service.createDraft(blueprint());
    const publishedDraft = await fixture.service.publishDraft(published.id, published.revision, bindings);
    assert.deepEqual(await fixture.service.deleteDraft(published.id), { id: published.id });
    await assert.rejects(fixture.service.getDraft(published.id), /does not exist/);
    assert.ok((await fixture.agentConfig.listTeams()).teams.some((team) => team.team_name === publishedDraft.source_team_name));
    await fixture.agentConfig.activateTeam(publishedDraft.source_team_name);
    await fixture.agentConfig.patchConfig("lead", { description: "Edited after its Draft was deleted" });
    const recreated = await fixture.service.synchronizeTeamDraft(publishedDraft.source_team_name, bindings);
    assert.notEqual(recreated.id, published.id);
    assert.equal(recreated.status, "published");
    assert.equal(recreated.source_team_name, publishedDraft.source_team_name);
    assert.equal(recreated.blueprint.agents[0].description, "Edited after its Draft was deleted");
    await fixture.service.deleteDraft(recreated.id);
    await fixture.agentConfig.deleteTeam(publishedDraft.source_team_name);
    assert.equal(await fixture.service.restoreDraftAfterTeamDelete(publishedDraft.source_team_name), null);

    const restorable = await fixture.service.createDraft(blueprint());
    const restorablePublished = await fixture.service.publishDraft(restorable.id, restorable.revision, bindings);
    const renamedTeam = `${restorablePublished.source_team_name}-renamed`;
    await fixture.agentConfig.renameTeam(restorablePublished.source_team_name, renamedTeam);
    const renamed = await fixture.service.synchronizeTeamDraft(
      renamedTeam,
      bindings,
      { previousTeamName: restorablePublished.source_team_name },
    );
    assert.equal(renamed.status, "published");
    assert.equal(renamed.source_team_name, renamedTeam);
    await fixture.agentConfig.deleteTeam(renamedTeam);
    const restored = await fixture.service.restoreDraftAfterTeamDelete(renamedTeam);
    assert.equal(restored.id, restorable.id);
    assert.equal(restored.status, "draft");
    assert.equal(restored.source_team_name, null);
    assert.equal(restored.published_at, null);
    assert.deepEqual(await fixture.service.deleteDraft(restored.id), { id: restored.id });
  } finally {
    fixture.cleanup();
  }
});

test("a deleted published Agent Draft is rebuilt from its Team configuration", async () => {
  const fixture = await createFixture();
  try {
    const bindings = new MemoryBindings();
    const created = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.publishDraft(created.id, created.revision, bindings);
    await fixture.service.deleteDraft(published.id);
    await fixture.agentConfig.activateTeam("support-team");
    await fixture.agentConfig.patchConfig("lead", { description: "Recovered live Agent" });

    const restored = await fixture.service.createDraftForEditing(blueprint(), bindings);
    assert.notEqual(restored.id, published.id);
    assert.equal(restored.status, "published");
    assert.equal(restored.source_team_name, "support-team");
    assert.equal(restored.blueprint.agents.find((agent) => agent.name === "lead").description, "Recovered live Agent");
    assert.equal((await fixture.service.listDrafts()).length, 1);
    await assert.rejects(
      fixture.service.createDraftForEditing(blueprint(), bindings),
      /already targets 'support-team'/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("workspace validation failure does not synchronize the system Agent draft", async () => {
  const fixture = await createFixture();
  try {
    const workspace = path.join(fixture.root, "session-workspace");
    const created = await fixture.service.createWorkspaceDraft("workspace-team", "Workspace draft", workspace);
    const localBlueprintPath = path.join(created.workspacePath, "blueprint.json");
    const localBlueprint = JSON.parse(fs.readFileSync(localBlueprintPath, "utf8"));
    localBlueprint.agents[0].tools = ["missing"];
    fs.writeFileSync(localBlueprintPath, `${JSON.stringify(localBlueprint, null, 2)}\n`);

    await assert.rejects(
      fixture.service.publishWorkspaceDraft(created.draft.id, workspace, new MemoryBindings()),
      AgentBuilderValidationError,
    );
    const unchanged = await fixture.service.getDraft(created.draft.id);
    assert.equal(unchanged.revision, 1);
    assert.deepEqual(unchanged.blueprint.agents[0].tools, []);
  } finally {
    fixture.cleanup();
  }
});

test("workspace publish auto-publishes edits through the same Agent Draft", async () => {
  const fixture = await createFixture([], {
    getSection: (key) => key === "agent_builder"
      ? { approval: { auto_publish_candidates: true } }
      : undefined,
  });
  try {
    const workspace = path.join(fixture.root, "session-workspace");
    const created = await fixture.service.createWorkspaceDraft("workspace-team", "Workspace draft", workspace);
    const first = await fixture.service.publishWorkspaceDraft(created.draft.id, workspace, new MemoryBindings());
    assert.equal(first.auto_published, true);
    assert.equal(first.draft.status, "published");
    assert.equal(first.draft.revision, created.draft.revision + 1);
    assert.equal(first.draft.source_team_name, "workspace-team");

    const localBlueprintPath = path.join(created.workspacePath, "blueprint.json");
    const localBlueprint = JSON.parse(fs.readFileSync(localBlueprintPath, "utf8"));
    localBlueprint.description = "Updated workspace Team";
    fs.writeFileSync(localBlueprintPath, `${JSON.stringify(localBlueprint, null, 2)}\n`);
    const second = await fixture.service.publishWorkspaceDraft(created.draft.id, workspace, new MemoryBindings());
    assert.equal(second.draft.id, created.draft.id);
    assert.equal(second.draft.status, "published");
    assert.equal(second.draft.revision, first.draft.revision + 1);
    assert.equal(second.draft.source_team_name, "workspace-team");
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

test("plugin subscribes to generic Agent configuration events", async () => {
  const fixture = await createFixture();
  const manager = installedAgentBuilderManager();
  let runtime = null;
  let released = 0;
  try {
    await manager.register();
    await manager.initializeApplication({
      registry: {
        async acquire(tenantId) {
          assert.equal(tenantId, "tenant-test");
          assert.ok(runtime);
          return {
            tenantId,
            runtime: { pluginCapabilities: runtime.capabilities },
            release() { released += 1; },
          };
        },
      },
    });
    runtime = await manager.runtimeContributions().createRuntime(runtimeContext(fixture));

    await fixture.agentConfig.createTeam("event-team");
    await fixture.agentConfig.copyAgentsToTeam("event-team", "default", ["general_agent"]);
    await manager.emit(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: "tenant-test",
      teamName: "event-team",
      change: "updated",
    });

    const builder = runtime.capabilities.require(AGENT_BUILDER_RUNTIME_CAPABILITY).service;
    const [created] = await builder.listDrafts();
    assert.equal(created.status, "published");
    assert.equal(created.source_team_name, "event-team");

    await fixture.agentConfig.renameTeam("event-team", "renamed-event-team");
    await manager.emit(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: "tenant-test",
      teamName: "renamed-event-team",
      change: "updated",
      previousTeamName: "event-team",
    });
    const [renamed] = await builder.listDrafts();
    assert.equal(renamed.id, created.id);
    assert.equal(renamed.status, "published");
    assert.equal(renamed.source_team_name, "renamed-event-team");

    await fixture.agentConfig.deleteTeam("renamed-event-team");
    await manager.emit(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: "tenant-test",
      teamName: "renamed-event-team",
      change: "deleted",
    });
    const [restored] = await builder.listDrafts();
    assert.equal(restored.id, created.id);
    assert.equal(restored.status, "draft");
    assert.equal(restored.source_team_name, null);
    assert.equal(released, 3);
  } finally {
    await manager.stop();
    runtime?.dispose();
    fixture.cleanup();
  }
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

test("Builder template migration adds Skill authoring tools without replacing user changes", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.tools.enabled_tools = ["read_file", "custom_tool"];
    legacy.builder_orchestrator.display_name = "Customized Builder";
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = "Keep this custom instruction.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 1;
    legacy.custom_reviewer = {
      ...legacy.agent_evaluator,
      agent_name: "custom_reviewer",
      display_name: "Custom Reviewer",
      tools: { enabled_tools: ["custom_tool"] },
      custom_params: { user_customized: true },
    };
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);
    const customBefore = fixture.agentConfig.getConfig("custom_reviewer", { teamName: AGENT_BUILDER_TEAM_NAME });

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const configs = fixture.agentConfig.listConfigs({ teamName: AGENT_BUILDER_TEAM_NAME });
    assert.equal(configs.builder_orchestrator.display_name, "Customized Builder");
    assert.deepEqual(configs.custom_reviewer, customBefore);
    assert.deepEqual(
      configs.builder_orchestrator.tools.enabled_tools,
      [
        "read_file",
        "custom_tool",
        "list_agent_builder_capabilities",
        "write_file",
        "edit_file",
        "list_skill_drafts",
        "get_skill_draft",
        "create_skill_draft",
        "publish_skill_draft",
        "list_agent_drafts",
        "get_agent_draft",
        "create_agent_draft",
        "publish_agent_draft",
      ],
    );
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /^Keep this custom instruction\./);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /publish_skill_draft/);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /Skill authoring runtime contract:/);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /current Skill runtime executes Python only/);
    assert.equal(configs.builder_orchestrator.custom_params.behavior.builder_template_version, 10);
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

test("Builder template migration adds the workspace draft workflow", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = "Keep this custom builder instruction.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 3;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    assert.match(orchestrator.custom_params.behavior.system_prompt, /^Keep this custom builder instruction\./);
    assert.match(orchestrator.custom_params.behavior.system_prompt, /publish_skill_draft/);
    assert.match(orchestrator.custom_params.behavior.system_prompt, /current Session workspace/);
    assert.match(orchestrator.custom_params.behavior.system_prompt, /execute_skill_script can run only a published, visible Skill/);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 10);
  } finally {
    fixture.cleanup();
  }
});

test("Builder template migration upgrades a version 7 Skill authoring prompt", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.custom_params.behavior.system_prompt =
      "Keep this version 7 instruction. Existing workflow already calls publish_skill_draft.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 7;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    assert.match(orchestrator.custom_params.behavior.system_prompt, /^Keep this version 7 instruction\./);
    assert.match(orchestrator.custom_params.behavior.system_prompt, /Skill authoring runtime contract:/);
    assert.match(orchestrator.custom_params.behavior.system_prompt, /current Skill runtime executes Python only/);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 10);
  } finally {
    fixture.cleanup();
  }
});

test("Builder template migration removes stale Artifact authoring instructions at the current version", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.tools.enabled_tools.push("submit_skill_artifact", "create_skill_artifact");
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = [
      "Keep this builder instruction.",
      "When the workflow contains reusable domain instructions, create a kind=skill Artifact.",
      "Use submit_skill_artifact and RAGSYSTEM_ARTIFACT_OUTPUT_DIR.",
      "Use list_skill_drafts or search_skill_drafts.",
    ].join(" ");
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 10;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    const prompt = orchestrator.custom_params.behavior.system_prompt;
    assert.match(prompt, /^Keep this builder instruction\./);
    assert.match(prompt, /Skill authoring runtime contract:/);
    assert.doesNotMatch(prompt, /Artifact|RAGSYSTEM_ARTIFACT_OUTPUT_DIR|submit_skill_artifact|search_skill_drafts/i);
    assert.equal(orchestrator.tools.enabled_tools.includes("submit_skill_artifact"), false);
    assert.equal(orchestrator.tools.enabled_tools.includes("create_skill_artifact"), false);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 10);
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
        "list_agent_builder_capabilities",
        "list_agent_drafts",
        "publish_agent_draft",
      ]);
      assert.deepEqual(ordinaryTools, []);

      const byName = new Map(builderTools.map((tool) => [tool.name, tool]));
      const toolContext = { executionPaths: { workspace: fixture.root } };
      const created = await byName.get("create_agent_draft").call({
        name: "workspace-team",
        description: "Built in a Session workspace",
      }, toolContext);
      assert.equal(created.success, true);
      assert.equal(created.content.revision, 1);
      assert.equal(fs.existsSync(path.join(created.content.workspace_path, "blueprint.json")), true);

      const loaded = await byName.get("get_agent_draft").call({ draft_id: created.content.id }, toolContext);
      assert.equal(loaded.success, true);
      assert.equal(loaded.content.id, created.content.id);

      const localBlueprint = JSON.parse(fs.readFileSync(path.join(created.content.workspace_path, "blueprint.json"), "utf8"));
      localBlueprint.description = "Updated by the Builder Team";
      fs.writeFileSync(path.join(created.content.workspace_path, "blueprint.json"), `${JSON.stringify(localBlueprint, null, 2)}\n`);
      const published = await byName.get("publish_agent_draft").call({ draft_id: created.content.id }, toolContext);
      assert.equal(published.success, true);
      assert.equal(published.content.revision, 2);
      assert.equal(published.content.auto_published, false);

      const listed = await byName.get("list_agent_drafts").call({}, {});
      assert.equal(listed.success, true);
      assert.equal(listed.content.length, 1);
      assert.equal(listed.content[0].revision, 2);

      const searched = await byName.get("list_agent_drafts").call({ query: "workspace" }, {});
      assert.equal(searched.success, true);
      assert.equal(searched.content.length, 1);
    } finally {
      runtime.dispose();
    }
  } finally {
    fixture.cleanup();
  }
});

test("Builder capability inventory exposes existing Tools, Skills, and MCP Servers", async () => {
  const fixture = await createFixture([{
    name: "read_file",
    description: "Read a managed file",
    category: "filesystem",
    risk_level: "low",
  }]);
  try {
    const capabilities = new CapabilityRegistry([
      provideCapability(SKILLS_RUNTIME_CAPABILITY, {
        library: {
          listSkills: async () => [{ name: "review-code", display_name: "Review Code", description: "Review changes" }],
        },
        tools: {
          loadAllSkills: () => [{
            name: "review-code",
            description: "Review changes",
            requires: { mcp_servers: ["github"] },
          }],
        },
      }),
      provideCapability(MCP_RUNTIME_CAPABILITY, {
        application: {
          listServers: async () => [{
            name: "github",
            display_name: "GitHub",
            transport: "streamable_http",
            enabled: true,
            status: "connected",
            tool_count: 3,
          }],
        },
      }),
    ]);
    const tool = createAgentBuilderTools(fixture.service, capabilities)
      .find((item) => item.name === "list_agent_builder_capabilities");
    assert.ok(tool);
    const result = await tool.call({}, {});
    assert.equal(result.success, true);
    assert.deepEqual(result.content.tools.find((item) => item.name === "read_file"), {
      name: "read_file",
      description: "Read a managed file",
      category: "filesystem",
      risk_level: "low",
    });
    assert.deepEqual(result.content.skills, [
      {
        name: "review-code",
        display_name: "Review Code",
        description: "Review changes",
        requires: { mcp_servers: ["github"] },
      },
    ]);
    assert.deepEqual(result.content.mcp_servers, [{
      name: "github",
      display_name: "GitHub",
      transport: "streamable_http",
      enabled: true,
      status: "connected",
      tool_count: 3,
    }]);
  } finally {
    fixture.cleanup();
  }
});

test("Builder template opts its orchestrator into Skill authoring tools explicitly", () => {
  const team = buildAgentBuilderTeam();
  const orchestrator = team.builder_orchestrator;
  assert.deepEqual(
    orchestrator.tools.enabled_tools.filter((name) => name.includes("skill_draft")),
    ["list_skill_drafts", "get_skill_draft", "create_skill_draft", "publish_skill_draft"],
  );
  for (const [name, agent] of Object.entries(team)) {
    if (name === "builder_orchestrator") continue;
    assert.equal(agent.tools.enabled_tools.some((tool) => tool.endsWith("_skill_draft")), false);
  }
  const prompt = orchestrator.custom_params.behavior.system_prompt;
  assert.match(prompt, /root SKILL\.md/);
  assert.match(prompt, /scripts\/ with a \.py extension/);
  assert.match(prompt, /root requirements\.txt/);
  assert.match(prompt, /Never instruct an Agent to run python, python3, a shell, execute_code/);
  assert.match(prompt, /publish action validates and synchronizes bundle structure but does not execute scripts/);
  assert.match(prompt, /choose workspace cwd or copy the deliverable into workspace/);
  assert.doesNotMatch(prompt, /Artifact|RAGSYSTEM_ARTIFACT_OUTPUT_DIR|submit_skill_artifact/i);
});

async function createFixture(pluginTools = [], systemConfig = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-builder-"));
  const agentConfig = new AgentConfigService(new MemoryTeamStore());
  await agentConfig.initialize();
  return {
    root,
    agentConfig,
    service: new AgentBuilderService(new FilesystemAgentBuilderStore(root), agentConfig, pluginTools, systemConfig),
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
