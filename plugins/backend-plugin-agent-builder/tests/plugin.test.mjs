import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_CONFIG_CHANGED_EVENT } from "@ragsystem/backend-core/contracts/agent/agent-config-events.js";
import { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { provideAgentCapability } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";

import { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  AgentBuilderConflictError,
  AgentBuilderNotFoundError,
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
  runDraftTrial,
  collectTeamFailures,
  renderTeamFailureMarkdown,
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

function fakeCapabilityProvider(id, names = []) {
  const config = new Map();
  return {
    id,
    display_name: `provider ${id}`,
    items: names.map((name) => ({ name })),
    config,
    failNextWrite: false,
    async listItems() {
      return this.items;
    },
    async getAgentConfig(teamName, agentName) {
      return [...(this.config.get(`${teamName}/${agentName}`) ?? [])];
    },
    async putAgentConfig(teamName, agentName, names) {
      if (this.failNextWrite && names.length > 0) {
        this.failNextWrite = false;
        throw new Error(`${id} write failed`);
      }
      this.config.set(`${teamName}/${agentName}`, [...names]);
    },
  };
}

function memoryBindings() {
  const skills = fakeCapabilityProvider("skills", ["review-code"]);
  const mcp = fakeCapabilityProvider("mcp", ["github"]);
  return {
    skills,
    mcp,
    inventory: {
      tools: new Set(["read_file", "write_file"]),
      providers: new Map([
        [skills.id, new Set(["review-code"])],
        [mcp.id, new Set(["github"])],
      ]),
    },
    providers: [skills, mcp],
  };
}

test("validation rejects missing capabilities and delegation cycles", () => {
  const report = validateBlueprint(blueprint({
    agents: [
      agent("lead", { tools: ["missing"], delegates: ["worker"] }),
      agent("worker", { delegates: ["lead"] }),
    ],
  }), {
    tools: new Set(["read_file"]),
    providers: new Map([
      ["skills", new Set()],
      ["mcp", new Set()],
    ]),
  });
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "unknown_tool"));
  assert.ok(report.issues.some((issue) => issue.code === "delegation_cycle"));
});

test("a router-only entry agent warns while capable entries pass", () => {
  const inventory = {
    tools: new Set(["read_file", "write_file"]),
    providers: new Map([
      ["skills", new Set(["review-code"])],
      ["mcp", new Set()],
    ]),
  };

  const routerOnly = validateBlueprint(blueprint({
    agents: [
      agent("lead", { delegates: ["worker"] }),
      agent("worker", { tools: ["write_file"] }),
    ],
  }), inventory);
  assert.equal(routerOnly.valid, true);
  const warning = routerOnly.issues.find((issue) => issue.code === "router_only_entry_agent");
  assert.ok(warning);
  assert.equal(warning.level, "warning");
  assert.equal(warning.path, "agents.0.tools");

  const withTools = validateBlueprint(blueprint({
    agents: [
      agent("lead", { tools: ["read_file"], delegates: ["worker"] }),
      agent("worker", { tools: ["write_file"] }),
    ],
  }), inventory);
  assert.equal(withTools.issues.some((issue) => issue.code === "router_only_entry_agent"), false);

  const withSkills = validateBlueprint(blueprint({
    agents: [
      agent("lead", { skills: ["review-code"], delegates: ["worker"] }),
      agent("worker", { tools: ["write_file"] }),
    ],
  }), inventory);
  assert.equal(withSkills.issues.some((issue) => issue.code === "router_only_entry_agent"), false);

  const singleAgent = validateBlueprint(blueprint({
    agents: [agent("lead")],
  }), inventory);
  assert.equal(singleAgent.issues.some((issue) => issue.code === "router_only_entry_agent"), false);
});

test("publishing materializes the Draft as a same-name Team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = memoryBindings();
    const draft = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    assert.equal(published.status, "published");
    assert.equal(published.revision, draft.revision + 1);
    assert.equal(published.source_team_name, "support-team");
    assert.ok(published.published_at);
    assert.deepEqual(Object.keys(fixture.agentConfig.listConfigs({ teamName: "support-team" })).sort(), ["lead", "worker"]);
    assert.deepEqual(bindings.skills.config.get("support-team/lead"), ["review-code"]);
    assert.deepEqual(bindings.mcp.config.get("support-team/lead"), ["github"]);

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
    const bindings = memoryBindings();
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
    const bindings = memoryBindings();
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
    const bindings = memoryBindings();
    const draft = await fixture.service.createDraft(blueprint());
    const published = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    const originalConfig = fixture.agentConfig.getConfig("lead", { teamName: "support-team" });
    const edited = await fixture.service.updateDraft(published.id, published.revision, blueprint({
      agents: [
        agent("lead", { description: "Must roll back", tools: ["read_file"], skills: ["review-code"], mcp_servers: ["github"], delegates: ["worker"] }),
        agent("worker", { description: "Worker" }),
      ],
    }));
    bindings.mcp.failNextWrite = true;

    await assert.rejects(
      fixture.service.publishDraft(edited.id, edited.revision, bindings),
      /mcp write failed/,
    );

    const liveConfig = fixture.agentConfig.getConfig("lead", { teamName: "support-team" });
    assert.equal(liveConfig.description, originalConfig.description);
    assert.deepEqual(bindings.mcp.config.get("support-team/lead"), ["github"]);
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
    const bindings = memoryBindings();
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
    const bindings = memoryBindings();
    bindings.mcp.failNextWrite = true;
    const draft = await fixture.service.createDraft(blueprint());
    await assert.rejects(
      fixture.service.publishDraft(draft.id, draft.revision, bindings),
      /mcp write failed/,
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
    const bindings = memoryBindings();
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
    const bindings = memoryBindings();
    await fixture.agentConfig.createTeam("copied-team");
    await fixture.agentConfig.copyAgentsToTeam("copied-team", "default", ["general_agent"]);
    bindings.skills.config.set("copied-team/general_agent", ["review-code"]);
    bindings.mcp.config.set("copied-team/general_agent", ["github"]);

    const created = await fixture.service.synchronizeTeamDraft("copied-team", bindings);
    assert.ok(created);
    assert.equal(created.status, "published");
    assert.equal(created.source_team_name, "copied-team");
    assert.equal(created.blueprint.entry_agent, "general_agent");
    assert.deepEqual(created.blueprint.agents[0].capabilities.skills, ["review-code"]);
    assert.deepEqual(created.blueprint.agents[0].capabilities.mcp, ["github"]);

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
    const bindings = memoryBindings();
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
    const bindings = memoryBindings();
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
    const bindings = memoryBindings();
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
      fixture.service.publishWorkspaceDraft(created.draft.id, workspace, memoryBindings()),
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
    const first = await fixture.service.publishWorkspaceDraft(created.draft.id, workspace, memoryBindings());
    assert.equal(first.auto_published, true);
    assert.equal(first.draft.status, "published");
    assert.equal(first.draft.revision, created.draft.revision + 1);
    assert.equal(first.draft.source_team_name, "workspace-team");

    const localBlueprintPath = path.join(created.workspacePath, "blueprint.json");
    const localBlueprint = JSON.parse(fs.readFileSync(localBlueprintPath, "utf8"));
    localBlueprint.description = "Updated workspace Team";
    fs.writeFileSync(localBlueprintPath, `${JSON.stringify(localBlueprint, null, 2)}\n`);
    const second = await fixture.service.publishWorkspaceDraft(created.draft.id, workspace, memoryBindings());
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
        "validate_agent_draft",
        "publish_agent_draft",
        "try_agent_draft",
        "collect_team_failures",
      ],
    );
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /^Keep this custom instruction\./);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /publish_skill_draft/);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /Skill authoring runtime contract:/);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /current Skill runtime executes Python only/);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /validate_agent_draft/);
    assert.match(configs.builder_orchestrator.custom_params.behavior.system_prompt, /artifacts parameter/);
    assert.equal(configs.builder_orchestrator.custom_params.behavior.builder_template_version, 15);
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
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
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
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
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
    assert.doesNotMatch(prompt, /kind=skill Artifact|\[artifact:|RAGSYSTEM_ARTIFACT_OUTPUT_DIR|submit_skill_artifact|create_skill_artifact|search_skill_drafts/i);
    assert.equal(orchestrator.tools.enabled_tools.includes("submit_skill_artifact"), false);
    assert.equal(orchestrator.tools.enabled_tools.includes("create_skill_artifact"), false);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
  } finally {
    fixture.cleanup();
  }
});

test("Builder-only draft tools are visible only to the Builder entry Agent", async () => {
  const manualApprovalConfig = {
    getSection: (key) => key === "agent_builder"
      ? { approval: { auto_publish_candidates: false } }
      : undefined,
    registerExtension: () => () => undefined,
  };
  const fixture = await createFixture();
  try {
    const manager = installedAgentBuilderManager();
    await manager.register();
    const runtime = await manager.runtimeContributions().createRuntime(runtimeContext(fixture, manualApprovalConfig));
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
        "collect_team_failures",
        "create_agent_draft",
        "get_agent_draft",
        "list_agent_builder_capabilities",
        "list_agent_drafts",
        "publish_agent_draft",
        "try_agent_draft",
        "validate_agent_draft",
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

test("Builder capability inventory lists Tools and every registered capability provider", async () => {
  const fixture = await createFixture([{
    name: "read_file",
    description: "Read a managed file",
    category: "filesystem",
    risk_level: "low",
  }]);
  try {
    const capabilities = new CapabilityRegistry([
      provideAgentCapability({
        id: "skills",
        display_name: "技能",
        listItems: async () => [{
          name: "review-code",
          display_name: "Review Code",
          description: "Review changes",
          metadata: { requires: { mcp_servers: ["github"] } },
        }],
        getAgentConfig: async () => [],
        putAgentConfig: async () => undefined,
      }),
      provideAgentCapability({
        id: "mcp",
        display_name: "MCP 服务器",
        listItems: () => [{ name: "github", display_name: "GitHub" }],
        getAgentConfig: async () => [],
        putAgentConfig: async () => undefined,
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
    assert.deepEqual(result.content.capability_providers, [
      {
        id: "mcp",
        display_name: "MCP 服务器",
        items: [{ name: "github", display_name: "GitHub" }],
      },
      {
        id: "skills",
        display_name: "技能",
        items: [{
          name: "review-code",
          display_name: "Review Code",
          description: "Review changes",
          metadata: { requires: { mcp_servers: ["github"] } },
        }],
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("legacy v1 drafts on disk normalize to v2 capabilities at the read boundary", async () => {
  const fixture = await createFixture();
  try {
    const legacyDraft = {
      id: "draft_legacy000000000000000000001",
      revision: 1,
      status: "draft",
      source_team_name: null,
      blueprint: blueprint(),
      validation: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const draftsRoot = path.join(fixture.root, "agent-builder", "drafts");
    fs.mkdirSync(draftsRoot, { recursive: true });
    fs.writeFileSync(path.join(draftsRoot, `${legacyDraft.id}.json`), JSON.stringify(legacyDraft));

    const drafts = await fixture.service.listDrafts();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].blueprint.schema_version, 2);
    assert.equal(drafts[0].blueprint.agents[0].skills, undefined);
    assert.equal(drafts[0].blueprint.agents[0].mcp_servers, undefined);
    assert.deepEqual(drafts[0].blueprint.agents[0].capabilities, {
      skills: ["review-code"],
      mcp: ["github"],
    });
    assert.deepEqual(drafts[0].blueprint.acceptance, []);
  } finally {
    fixture.cleanup();
  }
});

test("capabilities of an unregistered provider fail validation only when non-empty", () => {
  const invalid = validateBlueprint(blueprint({
    agents: [agent("lead", { capabilities: { planning_agents: ["planning_agent_agent_1"], skills: ["review-code"] } })],
  }), {
    tools: new Set(["read_file"]),
    providers: new Map([["skills", new Set(["review-code"])]]),
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.code === "unknown_capability_provider"));

  const tolerant = validateBlueprint(blueprint({
    agents: [agent("lead", { capabilities: { planning_agents: [] } })],
  }), {
    tools: new Set(["read_file"]),
    providers: new Map([["skills", new Set(["review-code"])]]),
  });
  assert.equal(tolerant.valid, true);
});

test("a third capability provider joins publishing and rollback without agent-builder changes", async () => {
  const fixture = await createFixture();
  try {
    const bindings = memoryBindings();
    const planning = fakeCapabilityProvider("planning_agents", ["planning_agent_agent_1"]);
    bindings.providers.push(planning);
    bindings.inventory.providers.set("planning_agents", new Set(["planning_agent_agent_1"]));

    const draft = await fixture.service.createDraft(blueprint({
      agents: [
        agent("lead", {
          tools: ["read_file"],
          capabilities: {
            skills: ["review-code"],
            mcp: ["github"],
            planning_agents: ["planning_agent_agent_1"],
          },
          delegates: ["worker"],
        }),
        agent("worker", { tools: ["write_file"] }),
      ],
    }));
    const published = await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    assert.equal(published.status, "published");
    assert.deepEqual(planning.config.get("support-team/lead"), ["planning_agent_agent_1"]);
    assert.equal(published.blueprint.agents[0].capabilities.planning_agents.length, 1);

    planning.failNextWrite = true;
    const edited = await fixture.service.updateDraft(published.id, published.revision, blueprint({
      agents: [
        agent("lead", {
          tools: ["read_file"],
          capabilities: { skills: [], mcp: [], planning_agents: ["planning_agent_agent_1"] },
          delegates: ["worker"],
        }),
        agent("worker", { tools: ["write_file"] }),
      ],
    }));
    await assert.rejects(
      fixture.service.publishDraft(edited.id, edited.revision, bindings),
      /planning_agents write failed/,
    );
    assert.deepEqual(planning.config.get("support-team/lead"), ["planning_agent_agent_1"]);
    assert.deepEqual(bindings.skills.config.get("support-team/lead"), ["review-code"]);
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
  assert.doesNotMatch(prompt, /kind=skill Artifact|\[artifact:|RAGSYSTEM_ARTIFACT_OUTPUT_DIR|submit_skill_artifact|create_skill_artifact/i);
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

function runtimeContext(fixture, systemConfig = null) {
  return {
    deploymentKind: "local",
    tenantId: "tenant-test",
    dataRoot: fixture.root,
    agentConfig: fixture.agentConfig,
    ...(systemConfig ? { systemConfig } : {}),
  };
}

test("Builder template migration replaces the v10 draft workflow sentence in place", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = [
      "You are the Agent Builder Orchestrator.",
      "Use list_agent_drafts, with a query when needed, to find a Draft; use get to copy it into the current Session workspace, or create to start a new workspace Draft. Edit blueprint.json with file tools, then call publish; publish performs validation and synchronization automatically.",
    ].join(" ");
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 10;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    const prompt = orchestrator.custom_params.behavior.system_prompt;
    assert.match(prompt, /validate_agent_draft/);
    assert.match(prompt, /blueprint\.schema\.md/);
    assert.match(prompt, /artifacts parameter/);
    assert.doesNotMatch(prompt, /then call publish; publish performs validation and synchronization automatically/);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

test("draft revisions are archived and rollback restores an older blueprint", async () => {
  const fixture = await createFixture();
  try {
    const original = await fixture.service.createDraft(blueprint());
    const edited = await fixture.service.updateDraft(original.id, original.revision, blueprint({
      description: "Edited description",
    }));
    assert.equal(edited.revision, 2);
    assert.deepEqual(await fixture.service.listDraftRevisions(edited.id), [1]);

    const rolledBack = await fixture.service.rollbackDraft(edited.id, edited.revision, 1);
    assert.equal(rolledBack.revision, 3);
    assert.equal(rolledBack.status, "draft");
    assert.equal(rolledBack.published_at, null);
    assert.equal(rolledBack.blueprint.description, original.blueprint.description);
    assert.deepEqual(await fixture.service.listDraftRevisions(edited.id), [2, 1]);

    await assert.rejects(
      () => fixture.service.rollbackDraft(edited.id, rolledBack.revision, 3),
      AgentBuilderConflictError,
    );
    await assert.rejects(
      () => fixture.service.rollbackDraft(edited.id, rolledBack.revision, 99),
      AgentBuilderConflictError,
    );
    await assert.rejects(
      () => fixture.service.rollbackDraft(edited.id, rolledBack.revision, 0),
      AgentBuilderNotFoundError,
    );
  } finally {
    fixture.cleanup();
  }
});

test("Builder template migration appends the Team design norms from version 11", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.display_name = "Customized Builder";
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = "Keep this custom instruction.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 11;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    const prompt = orchestrator.custom_params.behavior.system_prompt;
    assert.equal(orchestrator.display_name, "Customized Builder");
    assert.match(prompt, /^Keep this custom instruction\./);
    assert.match(prompt, /Team design norms:/);
    assert.match(prompt, /most capable generalist/);
    assert.match(prompt, /Never design a router-only entry Agent/);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

test("a fresh Builder Team carries the capable-entry norms across its prompts", () => {
  const team = buildAgentBuilderTeam();
  const orchestratorPrompt = team.builder_orchestrator.custom_params.behavior.system_prompt;
  assert.match(orchestratorPrompt, /Team design norms:/);
  assert.match(orchestratorPrompt, /most capable generalist/);
  assert.match(orchestratorPrompt, /Never design a router-only entry Agent/);
  assert.match(orchestratorPrompt, /Domain exploration protocol:/);
  assert.match(orchestratorPrompt, /never invent domain facts/);
  assert.match(orchestratorPrompt, /Experience layering:/);
  assert.match(orchestratorPrompt, /Trial protocol:/);
  assert.ok(team.builder_orchestrator.tools.enabled_tools.includes("try_agent_draft"));
  assert.match(orchestratorPrompt, /blueprint\.json's acceptance field/);
  assert.match(team.requirements_researcher.custom_params.behavior.system_prompt, /mandatory build input/);
  assert.match(team.agent_architect.custom_params.behavior.system_prompt, /most capable generalist/);
  assert.match(team.agent_architect.custom_params.behavior.system_prompt, /Never propose a router-only entry Agent/);
  assert.match(team.agent_architect.custom_params.behavior.system_prompt, /Layer the exploration findings/);
  assert.match(team.agent_evaluator.custom_params.behavior.system_prompt, /router-only entry Agent/);
  assert.match(team.agent_evaluator.custom_params.behavior.system_prompt, /acceptance cases trace to real explored samples/);
});

test("Builder template migration appends the domain exploration and layering prompts from version 12", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = "Keep this custom instruction.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 12;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    const prompt = orchestrator.custom_params.behavior.system_prompt;
    assert.match(prompt, /^Keep this custom instruction\./);
    assert.match(prompt, /Domain exploration protocol:/);
    assert.match(prompt, /never invent domain facts/);
    assert.match(prompt, /Experience layering:/);
    assert.match(prompt, /blueprint\.json's acceptance field/);
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

test("acceptance cases warn when missing and survive Team synchronization", async () => {
  const fixture = await createFixture();
  try {
    const inventory = memoryBindings().inventory;
    const missing = validateBlueprint(blueprint(), inventory);
    assert.equal(missing.valid, true);
    assert.ok(missing.issues.some((issue) => issue.code === "missing_acceptance_cases"));

    const acceptance = [{ case: "Refund order #1024 within 30 days", expect_contains: ["refund"], source: "sample" }];
    const withCases = validateBlueprint(blueprint({ acceptance }), inventory);
    assert.equal(withCases.issues.some((issue) => issue.code === "missing_acceptance_cases"), false);

    const bindings = memoryBindings();
    const draft = await fixture.service.createDraft(blueprint({ acceptance }));
    await fixture.service.publishDraft(draft.id, draft.revision, bindings);
    await fixture.agentConfig.activateTeam("support-team");
    await fixture.agentConfig.patchConfig("lead", { description: "Edited while live" });
    const synced = await fixture.service.synchronizeTeamDraft("support-team", bindings);
    assert.deepEqual(synced.blueprint.acceptance, acceptance);
  } finally {
    fixture.cleanup();
  }
});

function fakeTrialRegistry(overrides = {}) {
  const calls = { sessions: [], executed: [], deletedSessions: [], snapshots: [] };
  const runtime = {
    agentConfig: {
      createTeamSnapshot: (input) => {
        calls.snapshots.push(input);
        return { team_name: input.teamName, team_revision: "rev", entry_agent_name: input.entryAgentName, agents: {} };
      },
    },
    sessionApplication: {
      ensureSession: async (input) => { calls.sessions.push(input); },
      deleteSession: async (sessionId) => { calls.deletedSessions.push(sessionId); return true; },
    },
    agentExecution: {
      executeSynchronously: async (request) => {
        calls.executed.push(request);
        return overrides.resultFor
          ? overrides.resultFor(request)
          : { success: true, suspended: false, answer: `echo:${request.task}`, execution_time: 12 };
      },
    },
    agentDelegation: {
      listSessionParticipants: async () => ({
        items: [
          { participant_id: "root", scope: "root", agent_name: null },
          { participant_id: "child-1", scope: "child", agent_name: "worker" },
        ],
        total: 2,
      }),
    },
  };
  let released = 0;
  return {
    calls,
    get released() { return released; },
    registry: {
      async acquire() { return { runtime, release: () => { released += 1; } }; },
    },
  };
}

async function createTrialWorkspace(fixture, overrides = {}) {
  const workspace = path.join(fixture.root, "session-workspace");
  const created = await fixture.service.createWorkspaceDraft(
    overrides.name ?? "trial-team",
    "Trial draft",
    workspace,
  );
  const blueprintPath = path.join(created.workspacePath, "blueprint.json");
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
  blueprint.entry_agent = "lead";
  blueprint.agents = [
    {
      name: "lead",
      description: "lead agent",
      instructions: "Lead resolves routine requests directly.",
      tools: ["read_file"],
      capabilities: { skills: ["review-code"], mcp: ["github"] },
      delegates: ["worker"],
    },
    {
      name: "worker",
      description: "worker agent",
      instructions: "Worker handles deep work.",
      tools: ["write_file"],
      capabilities: {},
      delegates: [],
    },
  ];
  blueprint.acceptance = [
    { case: "How long does a refund take?", expect_contains: ["echo:"], source: "sample" },
    { case: "Where is my order?", expect_contains: ["never-appears"], source: "sample" },
  ];
  fs.writeFileSync(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);
  return { workspace, draftId: created.draft.id, stagingPrefix: `staging-${blueprint.name}-` };
}

test("trial run executes acceptance inputs and cleans up the staging team", async () => {
  const fixture = await createFixture();
  try {
    const bindings = memoryBindings();
    const fake = fakeTrialRegistry();
    const { workspace, draftId, stagingPrefix } = await createTrialWorkspace(fixture);

    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings },
      draftId,
      workspace,
    );

    assert.ok(report.staging_team.startsWith(stagingPrefix), report.staging_team);
    assert.equal(report.results.length, 2);
    assert.equal(report.inputs_truncated, false);
    const [hit, miss] = report.results;
    assert.equal(hit.status, "completed");
    assert.deepEqual(hit.matched, ["echo:"]);
    assert.deepEqual(hit.missed, []);
    assert.deepEqual(hit.delegated_agents, ["worker"]);
    assert.equal(hit.execution_time_ms, 12000);
    assert.equal(miss.status, "completed");
    assert.deepEqual(miss.missed, ["never-appears"]);
    assert.equal(report.summary.all_expectations_met, false);
    assert.equal(report.summary.completed, 2);

    // 每条输入一次无头执行，入口为蓝图 entry agent，试用会话用完即删
    assert.deepEqual(fake.calls.executed.map((request) => request.task), [
      "How long does a refund take?",
      "Where is my order?",
    ]);
    assert.ok(fake.calls.executed.every((request) => request.agent === "lead" && request.executionKind === "agent-builder.trial"));
    assert.equal(fake.calls.deletedSessions.length, 2);
    assert.equal(fake.released, 1);

    // 暂存 Team 与能力绑定完全清理
    const teams = await fixture.agentConfig.listTeams();
    assert.equal(teams.teams.some((team) => team.team_name.startsWith("staging-")), false);
    assert.deepEqual(bindings.skills.config.get(`${report.staging_team}/lead`), []);
    assert.deepEqual(bindings.mcp.config.get(`${report.staging_team}/lead`), []);
  } finally {
    fixture.cleanup();
  }
});

test("explicit trial inputs above five are rejected instead of silently truncated", async () => {
  const fixture = await createFixture();
  try {
    const fake = fakeTrialRegistry();
    const { workspace, draftId } = await createTrialWorkspace(fixture);
    const inputs = Array.from({ length: 6 }, (_, index) => ({ case: `input-${index}` }));

    await assert.rejects(
      runDraftTrial(
        { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
        draftId,
        workspace,
        inputs,
      ),
      /最多 5 条|分批/,
    );
    // 拒绝发生在物化之前：没有暂存 Team，也没有模型调用
    assert.equal(fake.calls.executed.length, 0);
    const teams = await fixture.agentConfig.listTeams();
    assert.equal(teams.teams.some((team) => team.team_name.startsWith("staging-")), false);

    // 工具层同一条规则：zod schema 拒绝，暴露给模型的 JSON Schema 也声明 maxItems=5
    const tool = createAgentBuilderTools(fixture.service, undefined, {
      registry: fake.registry,
      tenantId: "tenant-test",
      bindingsProvider: async () => memoryBindings(),
    }).find((item) => item.name === "try_agent_draft");
    assert.equal(tool.parameters.properties.inputs.maxItems, 5);
    const parsed = tool.inputSchema.safeParse({ draft_id: draftId, inputs });
    assert.equal(parsed.success, false);
    assert.match(String(parsed.error?.issues?.[0]?.message ?? ""), /最多 5 条|分批/);
  } finally {
    fixture.cleanup();
  }
});

test("acceptance defaults beyond five are truncated and the dropped cases are listed", async () => {
  const fixture = await createFixture();
  try {
    const fake = fakeTrialRegistry();
    const { workspace, draftId } = await createTrialWorkspace(fixture);
    const blueprintPath = path.join(fixture.root, "session-workspace", ".ragsystem", "agent-builder", "drafts", draftId, "blueprint.json");
    const localBlueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
    localBlueprint.acceptance = Array.from({ length: 7 }, (_, index) => ({
      case: `case-${index}`,
      expect_contains: ["echo:"],
      source: "sample",
    }));
    fs.writeFileSync(blueprintPath, `${JSON.stringify(localBlueprint, null, 2)}\n`);

    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
      draftId,
      workspace,
    );

    assert.equal(report.results.length, 5);
    assert.equal(report.inputs_truncated, true);
    assert.deepEqual(report.truncated_inputs, ["case-5", "case-6"]);
    assert.equal(report.summary.total, 5);
  } finally {
    fixture.cleanup();
  }
});

test("suspended trial runs are reported instead of failing the whole trial", async () => {
  const fixture = await createFixture();
  try {
    const fake = fakeTrialRegistry({ resultFor: () => ({ success: false, suspended: true, answer: null }) });
    const { workspace, draftId } = await createTrialWorkspace(fixture);

    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
      draftId,
      workspace,
    );

    assert.ok(report.results.every((item) => item.status === "suspended"));
    assert.equal(report.summary.suspended, 2);
    assert.equal(report.summary.all_expectations_met, false);
  } finally {
    fixture.cleanup();
  }
});

test("structurally invalid blueprints refuse to materialize a staging team", async () => {
  const fixture = await createFixture();
  try {
    const fake = fakeTrialRegistry();
    const { workspace, draftId } = await createTrialWorkspace(fixture);
    const blueprintPath = path.join(fixture.root, "session-workspace", ".ragsystem", "agent-builder", "drafts", draftId, "blueprint.json");
    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
    blueprint.agents[0].delegates = ["ghost"];
    fs.writeFileSync(blueprintPath, `${JSON.stringify(blueprint, null, 2)}\n`);

    await assert.rejects(
      runDraftTrial(
        { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
        draftId,
        workspace,
      ),
      /ghost/,
    );
    const teams = await fixture.agentConfig.listTeams();
    assert.equal(teams.teams.some((team) => team.team_name.startsWith("staging-")), false);
    assert.equal(fake.calls.executed.length, 0);
  } finally {
    fixture.cleanup();
  }
});


test("Builder template v14 migrates the trial protocol and tool from version 13", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = "Keep this custom instruction.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 13;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    const prompt = orchestrator.custom_params.behavior.system_prompt;
    assert.match(prompt, /^Keep this custom instruction./);
    assert.match(prompt, /Trial protocol:/);
    assert.match(prompt, /evidence, not a gate/);
    assert.ok(orchestrator.tools.enabled_tools.includes("try_agent_draft"));
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

test("a failing input is isolated instead of discarding the whole trial report", async () => {
  const fixture = await createFixture();
  try {
    let ensureCalls = 0;
    const runtime = {
      agentConfig: {
        createTeamSnapshot: (input) => ({ team_name: input.teamName, team_revision: "rev", entry_agent_name: input.entryAgentName, agents: {} }),
      },
      sessionApplication: {
        ensureSession: async () => {
          ensureCalls += 1;
          if (ensureCalls === 2) throw new Error("session bootstrap exploded");
        },
        deleteSession: async () => true,
      },
      agentExecution: {
        executeSynchronously: async (request) => ({ success: true, suspended: false, answer: `echo:${request.task}` }),
      },
      agentDelegation: { listSessionParticipants: async () => ({ items: [], total: 0 }) },
    };
    const fake = { registry: { async acquire() { return { runtime, release: () => {} }; } } };
    const { workspace, draftId } = await createTrialWorkspace(fixture);

    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
      draftId,
      workspace,
    );

    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].status, "completed");
    assert.equal(report.results[1].status, "failed");
    assert.match(report.results[1].error, /session bootstrap exploded/);
    // 清理照常执行：暂存 Team 删除
    const teams = await fixture.agentConfig.listTeams();
    assert.equal(teams.teams.some((team) => team.team_name.startsWith("staging-")), false);
  } finally {
    fixture.cleanup();
  }
});

test("migration converges a torn mid-upgrade state even when the version stamp is already current", async () => {
  const fixture = await createFixture();
  try {
    // 复刻事故现场：热重载窗口中版本号已写 14，但 v14 的工具与协议未写入
    const torn = buildAgentBuilderTeam();
    torn.builder_orchestrator.custom_params.behavior.system_prompt = torn.builder_orchestrator.custom_params.behavior.system_prompt
      .split("Trial protocol:")[0].trim();
    torn.builder_orchestrator.tools.enabled_tools = torn.builder_orchestrator.tools.enabled_tools
      .filter((tool) => tool !== "try_agent_draft");
    torn.builder_orchestrator.custom_params.behavior.builder_template_version = 14;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, torn);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    assert.match(orchestrator.custom_params.behavior.system_prompt, /Trial protocol:/);
    assert.ok(orchestrator.tools.enabled_tools.includes("try_agent_draft"));
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

function modelCatalogFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-builder-"));
  return {
    root,
    agentConfig: new AgentConfigService(new MemoryTeamStore()),
    get service() {
      return new AgentBuilderService(
        new FilesystemAgentBuilderStore(root),
        this.agentConfig,
        [],
        null,
        {
          listProviders: () => [
            { name: "DeepSeek", key: null, provider_type: "deepseek", models: [{ name: "deepseek-chat" }] },
            { name: "Relay Gateway", key: "relay", provider_type: "openai_compatible", models: [{ name: "k2" }] },
          ],
        },
      );
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("publishing backfills missing llm_tiers.provider_type from the model catalog", async () => {
  const fixture = modelCatalogFixture();
  try {
    await fixture.agentConfig.initialize();
    const draft = await fixture.service.createDraft(blueprint({
      agents: [
        agent("lead", { tools: ["read_file"], delegates: ["worker"], llm: { provider: " deepseek ", model_name: "deepseek-chat" } }),
        agent("worker", {
          tools: ["write_file"],
          llm_tiers: {
            default: { provider: "relay", model_name: "k2" },
            fallback: { provider: "unknown-vendor", model_name: "mystery" },
            pinned: { provider: "DeepSeek", provider_type: "keep-me", model_name: "deepseek-chat" },
          },
        }),
      ],
    }));
    await fixture.service.publishDraft(draft.id, draft.revision, memoryBindings());

    const lead = fixture.agentConfig.getConfig("lead", { teamName: "support-team" });
    assert.equal(lead.llm_tiers.default.provider_type, "deepseek");
    const worker = fixture.agentConfig.getConfig("worker", { teamName: "support-team" });
    assert.equal(worker.llm_tiers.default.provider_type, "openai_compatible");
    assert.ok(worker.llm_tiers.fallback.provider_type == null, "unresolvable provider stays unbackfilled");
    assert.equal(worker.llm_tiers.pinned.provider_type, "keep-me");
  } finally {
    fixture.cleanup();
  }
});

test("trial staging materialization backfills provider_type identically to publish", async () => {
  const fixture = modelCatalogFixture();
  try {
    await fixture.agentConfig.initialize();
    const bindings = memoryBindings();
    const workspace = path.join(fixture.root, "session-workspace");
    const created = await fixture.service.createWorkspaceDraft("tier-team", "Tier draft", workspace);
    const blueprintPath = path.join(created.workspacePath, "blueprint.json");
    const localBlueprint = JSON.parse(fs.readFileSync(blueprintPath, "utf8"));
    localBlueprint.entry_agent = "lead";
    localBlueprint.agents = [
      {
        name: "lead",
        description: "lead agent",
        instructions: "Lead resolves routine requests directly.",
        tools: ["read_file"],
        llm_tiers: { default: { provider: "DeepSeek", model_name: "deepseek-chat" } },
        delegates: [],
      },
    ];
    localBlueprint.acceptance = [{ case: "hello", expect_contains: ["echo:"], source: "sample" }];
    fs.writeFileSync(blueprintPath, `${JSON.stringify(localBlueprint, null, 2)}\n`);

    const original = fixture.agentConfig.applyTeamPayload.bind(fixture.agentConfig);
    const payloads = [];
    fixture.agentConfig.applyTeamPayload = async (teamName, agents) => {
      payloads.push(structuredClone({ teamName, agents }));
      return original(teamName, agents);
    };

    const fake = fakeTrialRegistry();
    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings },
      created.draft.id,
      workspace,
    );

    const stagingPayload = payloads.find((payload) => payload.teamName === report.staging_team);
    assert.ok(stagingPayload, "staging team payload was captured");
    assert.equal(stagingPayload.agents.lead.llm_tiers.default.provider_type, "deepseek");
  } finally {
    fixture.cleanup();
  }
});

test("two consecutive identical errors short-circuit the remaining inputs as skipped", async () => {
  const fixture = await createFixture();
  try {
    const fake = fakeTrialRegistry({
      resultFor: () => ({ success: false, suspended: false, answer: null, error: "missing_llm_provider_type: 缺少 LLM provider_type" }),
    });
    const { workspace, draftId } = await createTrialWorkspace(fixture);
    const inputs = Array.from({ length: 4 }, (_, index) => ({ case: `input-${index}` }));

    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
      draftId,
      workspace,
      inputs,
    );

    assert.deepEqual(report.results.map((item) => item.status), ["failed", "failed", "skipped", "skipped"]);
    assert.match(report.results[2].skipped_reason, /missing_llm_provider_type/);
    assert.equal(report.results[2].error, null);
    // 短路后不再消耗模型调用
    assert.equal(fake.calls.executed.length, 2);
    assert.equal(report.summary.failed, 2);
    assert.equal(report.summary.skipped, 2);
  } finally {
    fixture.cleanup();
  }
});

test("missing execution_time falls back to wall-clock timing", async () => {
  const fixture = await createFixture();
  try {
    const fake = fakeTrialRegistry({
      resultFor: (request) => ({ success: true, suspended: false, answer: `echo:${request.task}` }),
    });
    const { workspace, draftId } = await createTrialWorkspace(fixture);

    const report = await runDraftTrial(
      { service: fixture.service, registry: fake.registry, tenantId: "tenant-test", bindings: memoryBindings() },
      draftId,
      workspace,
    );

    for (const row of report.results) {
      assert.equal(typeof row.execution_time_ms, "number");
      assert.ok(row.execution_time_ms >= 0);
    }
  } finally {
    fixture.cleanup();
  }
});

function fakeFailureRuntime(overrides = {}) {
  const sessions = new Map(overrides.sessions ?? []);
  const transcripts = new Map(overrides.transcripts ?? []);
  const runs = new Map(overrides.runs ?? []);
  const feedback = overrides.feedback ?? [];
  const calls = { negative: [] };
  const runtime = {
    sessionApplication: {
      listNegativeMessageFeedback: async (input) => {
        calls.negative.push(input ?? {});
        return feedback;
      },
      getSession: async (sessionId) => sessions.get(sessionId) ?? null,
      listMessages: async (input) => ({ items: transcripts.get(input.sessionId) ?? [], total: (transcripts.get(input.sessionId) ?? []).length }),
      listRuns: async (sessionId) => runs.get(sessionId) ?? [],
    },
  };
  const knownTeams = (overrides.teams ?? []).map((name) => ({ team_name: name }));
  const publishedRevisions = overrides.publishedRevisions ?? [];
  return {
    calls,
    registry: { async acquire() { return { runtime, release: () => {} }; } },
    service: {
      getAgentConfigPort: () => ({ listTeams: async () => ({ teams: knownTeams }) }),
      listPublishedTeamRevisions: async () => publishedRevisions,
    },
  };
}

function failureSession(teamName) {
  return {
    session_id: `sess-${teamName}`,
    team_snapshot: { team_name: teamName, team_revision: "rev", entry_agent_name: "lead", agents: {} },
    tenant_id: "tenant-test",
  };
}

test("collect_team_failures joins thumbs-down feedback with transcripts, runs, and delegation shape", async () => {
  const sessionId = "sess-support";
  // 真实可见转写形态：委派中间轮（react_intermediate）不进可见清单，
  // 只剩用户消息与根 assistant 终答——委派形态必须经 run 树还原
  const messages = [
    { id: "m1", seq: 1, role: "user", content_parts: [{ type: "text", text: "Why was my refund rejected?" }], child_agent_id: null },
    { id: "m4", seq: 4, role: "assistant", content_parts: [{ type: "text", text: "It was rejected because the 30-day refund window had already closed when you asked, and per policy the order can no longer be refunded automatically; here is what you can still do next." }], child_agent_id: null },
  ];
  const fake = fakeFailureRuntime({
    teams: ["support-team", "other-team"],
    publishedRevisions: [
      { team_name: "support-team", draft_id: "draft-1", revision: 3, team_revision_hash: "rev", published_at: "2026-08-01T00:00:00Z" },
      { team_name: "support-team", draft_id: "draft-1", revision: 4, team_revision_hash: "rev4-hash", published_at: "2026-08-20T00:00:00Z" },
    ],
    feedback: [
      { message_id: "m4", session_id: sessionId, tenant_id: "tenant-test", value: "down", comment: "没给出补救方案", user_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      { message_id: "x9", session_id: "sess-other", tenant_id: "tenant-test", value: "down", comment: null, user_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    ],
    sessions: new Map([
      [sessionId, failureSession("support-team")],
      ["sess-other", failureSession("other-team")],
    ]),
    transcripts: new Map([[sessionId, messages]]),
    runs: new Map([[sessionId, [
      { run_id: "r1", session_id: sessionId, parent_run_id: null, child_agent_id: null, final_message_id: "m4", agent_name: "lead", status: "completed", terminal_reason: null, task_summary: "refund rejection question" },
      { run_id: "r2", session_id: sessionId, parent_run_id: "r1", child_agent_id: "child-1", final_message_id: null, agent_name: "policy_worker", status: "completed", terminal_reason: null, task_summary: null },
      // 其他根 run 的子 run：不属于被踩轮次，不计入
      { run_id: "r9", session_id: sessionId, parent_run_id: "r8", child_agent_id: "child-9", final_message_id: null, agent_name: "outsider", status: "completed", terminal_reason: null, task_summary: null },
    ]]]),
  });

  const report = await collectTeamFailures({ service: fake.service, registry: fake.registry, tenantId: "tenant-test" }, "support-team");

  assert.equal(report.team_exists, true);
  assert.equal(report.tenant_rows_scanned, 2);
  assert.equal(report.has_more, false);
  assert.equal(report.sessions_matched, 1);
  assert.deepEqual(report.revision_links.map((link) => link.revision), [3, 4]);
  assert.equal(report.samples.length, 1);
  const sample = report.samples[0];
  assert.equal(sample.message_id, "m4");
  assert.equal(sample.comment, "没给出补救方案");
  assert.equal(sample.user_excerpt, "Why was my refund rejected?");
  assert.match(sample.answer_excerpt, /rejected because the 30-day refund window/);
  assert.equal(sample.answered_by, "lead");
  assert.equal(sample.run.status, "completed");
  assert.equal(sample.run.task_summary, "refund rejection question");
  assert.equal(sample.team_revision, "rev");
  assert.equal(sample.published_revision, 3);
  assert.equal(sample.run_linked, true);
  assert.equal(sample.delegate_calls, 1);
  assert.deepEqual(sample.child_agents, ["policy_worker"]);
  assert.equal(sample.entry_router_only, false);

  const markdown = renderTeamFailureMarkdown(report);
  assert.match(markdown, /团队失败证据：support-team/);
  assert.match(markdown, /revision 3 → rev/);
  assert.match(markdown, /发布 revision 3/);
  assert.match(markdown, /source: regression/);
  assert.match(markdown, /用户备注：\n> 没给出补救方案/);
});

test("collect_team_failures flags a router-only entry from the interaction window", async () => {
  const sessionId = "sess-router";
  // 可见转写：根 assistant 终答只是转述子 Agent 的产出（文本很短）
  const messages = [
    { id: "m1", seq: 1, role: "user", content_parts: [{ type: "text", text: "Summarize this report." }], child_agent_id: null },
    { id: "m3", seq: 3, role: "assistant", content_parts: [{ type: "text", text: "Here is the summary you asked for, produced entirely by the child." }], child_agent_id: null },
  ];
  const fake = fakeFailureRuntime({
    teams: ["router-team"],
    feedback: [
      { message_id: "m3", session_id: sessionId, tenant_id: "tenant-test", value: "down", comment: null, user_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    ],
    sessions: new Map([[sessionId, failureSession("router-team")]]),
    transcripts: new Map([[sessionId, messages]]),
    runs: new Map([[sessionId, [
      { run_id: "r-root", session_id: sessionId, parent_run_id: null, child_agent_id: null, final_message_id: "m3", agent_name: "lead", status: "completed", terminal_reason: null, task_summary: null },
      { run_id: "r-child", session_id: sessionId, parent_run_id: "r-root", child_agent_id: "child-1", final_message_id: null, agent_name: "summarizer", status: "completed", terminal_reason: null, task_summary: null },
    ]]]),
  });

  const report = await collectTeamFailures({ service: fake.service, registry: fake.registry, tenantId: "tenant-test" }, "router-team");

  const sample = report.samples[0];
  assert.equal(sample.run_linked, true);
  assert.equal(sample.delegate_calls, 1);
  assert.equal(sample.entry_own_text_chars, 66);
  assert.equal(sample.answered_by, "lead");
  assert.equal(sample.team_revision, "rev");
  assert.equal(sample.published_revision, null);
  assert.equal(sample.entry_router_only, true);
  assert.match(renderTeamFailureMarkdown(report), /入口疑似纯路由/);
  // 该夹具无任何已登记哈希的发布：未映射文案指向「早于哈希登记」而非「被直接改过」
  assert.match(renderTeamFailureMarkdown(report), /发布均早于哈希登记/);
});

test("collect_team_failures reports zero samples without inventing lessons", async () => {
  const fake = fakeFailureRuntime({ teams: ["quiet-team"], feedback: [] });
  const report = await collectTeamFailures({ service: fake.service, registry: fake.registry, tenantId: "tenant-test" }, "quiet-team");
  assert.equal(report.team_exists, true);
  assert.equal(report.samples.length, 0);
  assert.match(renderTeamFailureMarkdown(report), /暂无被踩样本/);
});

test("collect_team_failures refuses unknown teams without scanning or implying zero samples", async () => {
  const fake = fakeFailureRuntime({
    teams: ["support-team"],
    feedback: [
      { message_id: "m4", session_id: "sess-support", tenant_id: "tenant-test", value: "down", comment: null, user_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    ],
  });

  const report = await collectTeamFailures({ service: fake.service, registry: fake.registry, tenantId: "tenant-test" }, "no-such-team-probe");

  assert.equal(report.team_exists, false);
  assert.equal(report.tenant_rows_scanned, 0);
  assert.equal(report.samples.length, 0);
  // 未扫描：反馈存储根本没被触碰
  assert.equal(fake.calls.negative.length, 0);
  assert.match(renderTeamFailureMarkdown(report), /团队不存在/);
});

test("collect_team_failures flags has_more when the scan hits the feedback limit", async () => {
  const fake = fakeFailureRuntime({
    teams: ["support-team"],
    feedback: [
      { message_id: "m2", session_id: "sess-support", tenant_id: "tenant-test", value: "down", comment: null, user_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      { message_id: "m4", session_id: "sess-support", tenant_id: "tenant-test", value: "down", comment: null, user_id: "u1", created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:00Z" },
    ],
    sessions: new Map([["sess-support", failureSession("support-team")]]),
    transcripts: new Map([["sess-support", [
      { id: "m1", seq: 1, role: "user", content_parts: [{ type: "text", text: "q1" }], child_agent_id: null },
      { id: "m2", seq: 2, role: "assistant", content_parts: [{ type: "text", text: "a1" }], child_agent_id: null },
      { id: "m3", seq: 3, role: "user", content_parts: [{ type: "text", text: "q2" }], child_agent_id: null },
      { id: "m4", seq: 4, role: "assistant", content_parts: [{ type: "text", text: "a2" }], child_agent_id: null },
    ]]]),
    runs: new Map([["sess-support", []]]),
  });

  const report = await collectTeamFailures(
    { service: fake.service, registry: fake.registry, tenantId: "tenant-test" },
    "support-team",
    { feedbackLimit: 2 },
  );

  assert.equal(report.tenant_rows_scanned, 2);
  assert.equal(report.has_more, true);
  assert.match(renderTeamFailureMarkdown(report), /扫描上限/);
});

test("collect_team_failures tool writes the evidence file into the session workspace", async () => {
  const fixture = await createFixture();
  try {
    // 工具经真实 service 校验团队存在性：先注册目标团队
    await fixture.agentConfig.createTeam("support-team");
    const fake = fakeFailureRuntime({
      feedback: [
        { message_id: "m2", session_id: "sess-support", tenant_id: "tenant-test", value: "down", comment: null, user_id: "u1", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      ],
      sessions: new Map([["sess-support", failureSession("support-team")]]),
      transcripts: new Map([["sess-support", [
        { id: "m1", seq: 1, role: "user", content_parts: [{ type: "text", text: "hello" }], child_agent_id: null },
        { id: "m2", seq: 2, role: "assistant", content_parts: [{ type: "text", text: "bad answer" }], child_agent_id: null },
      ]]]),
      runs: new Map([["sess-support", []]]),
    });
    const tool = createAgentBuilderTools(fixture.service, undefined, {
      registry: fake.registry,
      tenantId: "tenant-test",
    }).find((item) => item.name === "collect_team_failures");
    assert.ok(tool);

    const workspace = path.join(fixture.root, "failure-workspace");
    const result = await tool.call({ team_name: "support-team" }, { executionPaths: { workspace } });

    assert.equal(result.success, true);
    assert.equal(result.content.team_exists, true);
    assert.equal(result.content.samples.length, 1);
    assert.equal(result.content.samples[0].run_linked, false);
    const evidencePath = path.join(workspace, result.content.evidence_file);
    assert.equal(fs.existsSync(evidencePath), true);
    assert.match(fs.readFileSync(evidencePath, "utf8"), /bad answer/);
    assert.match(fs.readFileSync(evidencePath, "utf8"), /委派观察不可用/);

    // 拼错团队名：不扫描、不落盘、明确报告 team_exists=false
    const miss = await tool.call({ team_name: "no-such-team-probe" }, { executionPaths: { workspace } });
    assert.equal(miss.success, true);
    assert.equal(miss.content.team_exists, false);
    assert.equal(miss.content.evidence_file, undefined);
    assert.equal(fake.calls.negative.length, 1);
    assert.equal(fs.existsSync(path.join(workspace, ".ragsystem", "agent-builder", "evidence", "failures-no-such-team-probe.md")), false);
  } finally {
    fixture.cleanup();
  }
});


test("Builder template v15 migrates the failure feedback protocol and tool from version 14", async () => {
  const fixture = await createFixture();
  try {
    const legacy = buildAgentBuilderTeam();
    legacy.builder_orchestrator.custom_params.behavior.system_prompt = "Keep this custom instruction.";
    legacy.builder_orchestrator.custom_params.behavior.builder_template_version = 14;
    await fixture.agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, legacy);

    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), true);
    const orchestrator = fixture.agentConfig.getConfig("builder_orchestrator", { teamName: AGENT_BUILDER_TEAM_NAME });
    assert.match(orchestrator.custom_params.behavior.system_prompt, /^Keep this custom instruction./);
    assert.match(orchestrator.custom_params.behavior.system_prompt, /Failure feedback protocol:/);
    assert.ok(orchestrator.tools.enabled_tools.includes("collect_team_failures"));
    assert.equal(orchestrator.custom_params.behavior.builder_template_version, 15);
    assert.equal(await ensureAgentBuilderTeam(fixture.agentConfig), false);
  } finally {
    fixture.cleanup();
  }
});

test('publishing records the team hash on the revision and republish overwrites it', async () => {
  const fixture = await createFixture();
  try {
    const draft = await fixture.service.createDraft(blueprint());
    await fixture.service.publishDraft(draft.id, draft.revision, memoryBindings());

    const first = await fixture.service.getDraft(draft.id);
    const currentHash = (await fixture.agentConfig.listTeams())
      .teams.find((team) => team.team_name === 'support-team')?.team_revision;
    assert.ok(currentHash);
    assert.equal(first.team_revision_hash, currentHash);
    assert.deepEqual(
      (await fixture.service.listPublishedTeamRevisions()).map((link) => link.revision),
      [first.revision],
    );

    // 改蓝图再发布：新 revision 记新哈希，不残留旧值
    const edited = structuredClone(first.blueprint);
    edited.agents[0].instructions = 'Lead handles refunds end to end itself.';
    await fixture.service.updateDraft(draft.id, first.revision, edited, validateBlueprint(edited, memoryBindings().inventory));
    const updated = await fixture.service.getDraft(draft.id);
    await fixture.service.publishDraft(draft.id, updated.revision, memoryBindings());

    const second = await fixture.service.getDraft(draft.id);
    const newHash = (await fixture.agentConfig.listTeams())
      .teams.find((team) => team.team_name === 'support-team')?.team_revision;
    assert.notEqual(newHash, currentHash);
    assert.equal(second.team_revision_hash, newHash);
    const links = await fixture.service.listPublishedTeamRevisions();
    assert.deepEqual(links.map((link) => link.revision), [first.revision, second.revision]);
    assert.ok(links.every((link) => link.team_revision_hash));
    assert.notEqual(links[0].team_revision_hash, links[1].team_revision_hash);
  } finally {
    fixture.cleanup();
  }
});


test('editing, rolling back, and team deletion clear team_revision_hash on draft-status revisions', async () => {
  const fixture = await createFixture();
  try {
    const draft = await fixture.service.createDraft(blueprint());
    await fixture.service.publishDraft(draft.id, draft.revision, memoryBindings());
    const published = await fixture.service.getDraft(draft.id);
    assert.ok(published.team_revision_hash);

    const edited = structuredClone(published.blueprint);
    edited.agents[0].instructions = 'Edited instructions.';
    await fixture.service.updateDraft(draft.id, published.revision, edited, validateBlueprint(edited, memoryBindings().inventory));
    assert.equal((await fixture.service.getDraft(draft.id)).team_revision_hash, null);

    await fixture.service.publishDraft(draft.id, (await fixture.service.getDraft(draft.id)).revision, memoryBindings());
    const republished = await fixture.service.getDraft(draft.id);
    assert.ok(republished.team_revision_hash);

    await fixture.service.rollbackDraft(draft.id, republished.revision, published.revision);
    assert.equal((await fixture.service.getDraft(draft.id)).team_revision_hash, null);

    // 团队被删（restore 路径）后哈希同样清空
    await fixture.service.publishDraft(draft.id, (await fixture.service.getDraft(draft.id)).revision, memoryBindings());
    await fixture.agentConfig.deleteTeam('support-team');
    const restored = await fixture.service.restoreDraftAfterTeamDelete('support-team');
    assert.ok(restored);
    assert.equal((await fixture.service.getDraft(draft.id)).team_revision_hash, null);
  } finally {
    fixture.cleanup();
  }
});

test('synchronizeTeamDraft re-reads the current team hash on the published sync branch', async () => {
  const fixture = await createFixture();
  try {
    const draft = await fixture.service.createDraft(blueprint());
    await fixture.service.publishDraft(draft.id, draft.revision, memoryBindings());
    const published = await fixture.service.getDraft(draft.id);
    assert.ok(published.team_revision_hash);

    // 团队被直接修改（绕过 Builder）后触发同步：同步 revision 必须带新哈希而非旧发布哈希
    await fixture.agentConfig.patchConfig('lead', { description: 'Edited outside the Builder' }, { teamName: 'support-team' });
    const synced = await fixture.service.synchronizeTeamDraft('support-team', memoryBindings());
    const currentHash = (await fixture.agentConfig.listTeams())
      .teams.find((team) => team.team_name === 'support-team')?.team_revision;
    assert.ok(currentHash);
    assert.notEqual(currentHash, published.team_revision_hash);
    assert.equal(synced.team_revision_hash, currentHash);
    // 同步后的哈希能被归因查询消费
    const links = await fixture.service.listPublishedTeamRevisions();
    assert.ok(links.some((link) => link.team_revision_hash === currentHash));
  } finally {
    fixture.cleanup();
  }
});
