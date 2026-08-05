import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, AgentLlmConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import type { SystemConfigService } from "@ragsystem/backend-core/services/config/system-config-service.js";

import {
  AgentBlueprintSchema,
  AgentDraftSchema,
  AgentReleaseSchema,
  type AgentBlueprint,
  type AgentBlueprintAgent,
  type AgentBuilderCapabilityInventory,
  type AgentBuilderValidationIssue,
  type AgentBuilderValidationReport,
  type AgentDraft,
  type AgentRelease,
} from "./contracts.js";
import type { AgentBuilderStore } from "./store.js";
import { resolveAgentBuilderApprovalConfig } from "./config.js";

export interface AgentBuilderBindings {
  readonly inventory: AgentBuilderCapabilityInventory;
  getSkillConfig(teamName: string, agentName: string): Promise<string[]>;
  putSkillConfig(teamName: string, agentName: string, skillNames: string[]): Promise<void>;
  getMcpConfig(teamName: string, agentName: string): Promise<string[]>;
  putMcpConfig(teamName: string, agentName: string, serverNames: string[]): Promise<void>;
}

export class AgentBuilderConflictError extends Error {}
export class AgentBuilderNotFoundError extends Error {}
export class AgentBuilderValidationError extends Error {
  constructor(readonly report: AgentBuilderValidationReport) {
    super("Agent draft validation failed");
  }
}

export class AgentBuilderService {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AgentBuilderStore,
    private readonly agentConfig: AgentConfigService,
    private readonly pluginTools: readonly BackendToolDescriptor[] = [],
    private readonly systemConfig: SystemConfigService | null = null,
  ) {}

  getAgentConfigService(): AgentConfigService {
    return this.agentConfig;
  }

  listAvailableTools(): BackendToolDescriptor[] {
    const tools = new Map<string, BackendToolDescriptor>();
    for (const tool of this.agentConfig.listAvailableTools()) {
      tools.set(tool.name, tool);
    }
    for (const tool of this.pluginTools) {
      tools.set(tool.name, tool);
    }
    return [...tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  listDrafts(): Promise<AgentDraft[]> {
    return this.store.listDrafts();
  }

  async searchDrafts(query: string | null | undefined): Promise<AgentDraft[]> {
    const normalized = (query ?? "").trim().toLowerCase();
    if (!normalized) return this.listDrafts();
    return (await this.listDrafts()).filter((draft) => [
      draft.id,
      draft.blueprint.name,
      draft.blueprint.description,
      ...draft.blueprint.agents.map((agent) => `${agent.name} ${agent.display_name ?? ""} ${agent.description}`),
    ].join(" ").toLowerCase().includes(normalized));
  }

  async getDraft(id: string): Promise<AgentDraft> {
    const draft = await this.store.getDraft(id);
    if (!draft) throw new AgentBuilderNotFoundError(`Agent draft '${id}' does not exist`);
    return draft;
  }

  createDraft(blueprintInput: AgentBlueprint, validation: AgentBuilderValidationReport | null = null): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const now = new Date().toISOString();
      const draft = AgentDraftSchema.parse({
        id: `draft_${randomUUID().replaceAll("-", "")}`,
        revision: 1,
        status: validation ? "ready" : "draft",
        blueprint: AgentBlueprintSchema.parse(blueprintInput),
        validation,
        published_release_id: null,
        created_at: now,
        updated_at: now,
      });
      await this.store.putDraft(draft);
      return draft;
    });
  }

  async createWorkspaceDraft(
    name: string,
    description: string,
    workspaceRoot: string,
  ): Promise<{ draft: AgentDraft; workspacePath: string }> {
    const draft = await this.createDraft({
      schema_version: 1,
      name,
      description,
      entry_agent: "main",
      agents: [{
        name: "main",
        description: "Primary entry agent",
        instructions: "Define the agent instructions in this blueprint before publishing.",
        tools: [],
        skills: [],
        mcp_servers: [],
        delegates: [],
        goals_enabled: false,
        background_tasks: false,
      }],
      acceptance_tests: [],
    });
    return this.materializeDraftToWorkspace(draft, workspaceRoot);
  }

  async materializeDraftToWorkspace(
    draftOrId: AgentDraft | string,
    workspaceRoot: string,
  ): Promise<{ draft: AgentDraft; workspacePath: string }> {
    const draft = typeof draftOrId === "string" ? await this.getDraft(draftOrId) : draftOrId;
    const workspacePath = agentDraftWorkspacePath(workspaceRoot, draft.id);
    await mkdir(workspacePath, { recursive: true });
    await writeWorkspaceJson(workspacePath, "manifest.json", {
      kind: "agent",
      draft_id: draft.id,
      expected_revision: draft.revision,
      name: draft.blueprint.name,
    });
    await writeWorkspaceJson(workspacePath, "blueprint.json", draft.blueprint);
    return { draft, workspacePath };
  }

  async publishWorkspaceDraft(
    draftId: string,
    workspaceRoot: string,
    bindings: AgentBuilderBindings,
  ): Promise<{ draft: AgentDraft; release: AgentRelease | null; auto_published: boolean; workspacePath: string }> {
    const current = await this.getDraft(draftId);
    const workspacePath = agentDraftWorkspacePath(workspaceRoot, draftId);
    const manifest = parseWorkspaceManifest(await readWorkspaceJson(workspacePath, "manifest.json"));
    if (manifest.draft_id !== draftId) throw new AgentBuilderConflictError("Workspace manifest draft_id does not match the requested draft");
    assertRevision(current, manifest.expected_revision);
    let blueprint: AgentBlueprint;
    try {
      blueprint = AgentBlueprintSchema.parse(await readWorkspaceJson(workspacePath, "blueprint.json"));
    } catch (error) {
      throw new AgentBuilderValidationError({
        valid: false,
        checked_at: new Date().toISOString(),
        issues: [{ level: "error", code: "invalid_blueprint", path: "blueprint.json", message: error instanceof Error ? error.message : String(error) }],
      });
    }
    const validation = validateBlueprint(blueprint, bindings.inventory);
    if (!validation.valid) throw new AgentBuilderValidationError(validation);

    const draft = current.status === "published" || current.published_release_id
      ? await this.createDraft(blueprint, validation)
      : await this.updateDraft(current.id, current.revision, blueprint, validation);
    const autoPublished = this.isAutoPublishEnabled();
    const release = autoPublished ? await this.publishDraft(draft.id, draft.revision, bindings) : null;
    const result = await this.getDraft(draft.id);
    await this.materializeDraftToWorkspace(result, workspaceRoot);
    return { draft: result, release, auto_published: Boolean(release), workspacePath: agentDraftWorkspacePath(workspaceRoot, result.id) };
  }

  isAutoPublishEnabled(): boolean {
    const approval = this.systemConfig
      ? resolveAgentBuilderApprovalConfig(
        this.systemConfig.getSection("agent_builder"),
        this.systemConfig.getSection("automation"),
      )
      : { auto_publish_releases: false };
    return approval.auto_publish_releases;
  }

  updateDraft(
    id: string,
    expectedRevision: number,
    blueprintInput: AgentBlueprint,
    validation: AgentBuilderValidationReport | null = null,
  ): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      assertRevision(current, expectedRevision);
      if (current.status === "published") {
        throw new AgentBuilderConflictError("Published drafts are immutable; create a new draft instead");
      }
      const updated = AgentDraftSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: validation ? "ready" : "draft",
        blueprint: AgentBlueprintSchema.parse(blueprintInput),
        validation,
        updated_at: new Date().toISOString(),
      });
      await this.store.putDraft(updated);
      return updated;
    });
  }

  async autoApproveDraft(
    draft: AgentDraft,
    bindingsProvider: () => Promise<AgentBuilderBindings>,
  ): Promise<AgentDraft> {
    const approval = this.systemConfig
      ? resolveAgentBuilderApprovalConfig(
        this.systemConfig.getSection("agent_builder"),
        this.systemConfig.getSection("automation"),
      )
      : { auto_publish_releases: false };
    if (!approval.auto_publish_releases) return draft;
    if (draft.status === "published" || draft.published_release_id) return draft;
    await this.publishDraft(draft.id, draft.revision, await bindingsProvider());
    return this.getDraft(draft.id);
  }

  validateDraft(id: string, inventory: AgentBuilderCapabilityInventory): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      if (current.status === "published") return current;
      const validation = validateBlueprint(current.blueprint, inventory);
      const updated = AgentDraftSchema.parse({
        ...current,
        status: validation.valid ? "ready" : "validation_failed",
        validation,
        updated_at: new Date().toISOString(),
      });
      await this.store.putDraft(updated);
      return updated;
    });
  }

  listReleases(packageName?: string): Promise<AgentRelease[]> {
    return this.store.listReleases(packageName);
  }

  async getRelease(id: string): Promise<AgentRelease> {
    const release = await this.store.getRelease(id);
    if (!release) throw new AgentBuilderNotFoundError(`Agent release '${id}' does not exist`);
    return release;
  }

  publishDraft(id: string, expectedRevision: number, bindings: AgentBuilderBindings): Promise<AgentRelease> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      assertRevision(current, expectedRevision);
      if (current.published_release_id) return this.getRelease(current.published_release_id);

      const validation = validateBlueprint(current.blueprint, bindings.inventory);
      if (!validation.valid) {
        throw new AgentBuilderValidationError(validation);
      }

      const existingReleases = await this.store.listReleases(current.blueprint.name);
      const version = Math.max(0, ...existingReleases.map((release) => release.version)) + 1;
      const runtimeTeamName = `${current.blueprint.name}--v${version}`;
      const teams = await this.agentConfig.listTeams();
      if (teams.teams.some((team) => team.team_name === runtimeTeamName)) {
        throw new AgentBuilderConflictError(
          `Runtime Team '${runtimeTeamName}' already exists; publishing will not overwrite it`,
        );
      }
      const publishedAt = new Date().toISOString();
      const release = AgentReleaseSchema.parse({
        id: `release_${randomUUID().replaceAll("-", "")}`,
        package_name: current.blueprint.name,
        version,
        runtime_team_name: runtimeTeamName,
        blueprint: current.blueprint,
        validation,
        source_draft_id: current.id,
        source_draft_revision: current.revision,
        published_at: publishedAt,
      });

      const rollback = await this.captureMaterialization(runtimeTeamName, bindings);
      let releaseCreated = false;
      try {
        await this.materialize(runtimeTeamName, current.blueprint, bindings, rollback);
        await this.store.createRelease(release);
        releaseCreated = true;
        await this.store.putDraft(AgentDraftSchema.parse({
          ...current,
          status: "published",
          validation,
          published_release_id: release.id,
          updated_at: publishedAt,
        }));
        return release;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (releaseCreated) {
          try {
            await this.store.deleteRelease(release.id);
          } catch (releaseRollbackError) {
            rollbackErrors.push(releaseRollbackError);
          }
        }
        try {
          await this.restoreMaterialization(runtimeTeamName, current.blueprint, bindings, rollback);
        } catch (materializationRollbackError) {
          rollbackErrors.push(materializationRollbackError);
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "Agent release failed and rollback was incomplete");
        }
        throw error;
      }
    });
  }

  private async captureMaterialization(teamName: string, bindings: AgentBuilderBindings): Promise<MaterializationSnapshot> {
    const teams = await this.agentConfig.listTeams();
    const existed = teams.teams.some((team) => team.team_name === teamName);
    const agents = existed ? this.agentConfig.listConfigs({ teamName }) : null;
    const skills = new Map<string, string[]>();
    const mcpServers = new Map<string, string[]>();
    if (existed) {
      for (const agentName of Object.keys(agents ?? {})) {
        skills.set(agentName, await bindings.getSkillConfig(teamName, agentName));
        mcpServers.set(agentName, await bindings.getMcpConfig(teamName, agentName));
      }
    }
    return { existed, agents, skills, mcpServers };
  }

  private async materialize(
    teamName: string,
    blueprint: AgentBlueprint,
    bindings: AgentBuilderBindings,
    snapshot: MaterializationSnapshot,
  ): Promise<void> {
    await this.agentConfig.applyTeamPayload(
      teamName,
      Object.fromEntries(blueprint.agents.map((agent) => [
        agent.name,
        toRuntimeAgent(agent, agent.name === blueprint.entry_agent),
      ])),
    );
    for (const agent of blueprint.agents) {
      await bindings.putSkillConfig(teamName, agent.name, agent.skills);
      await bindings.putMcpConfig(teamName, agent.name, agent.mcp_servers);
    }
    const nextNames = new Set(blueprint.agents.map((agent) => agent.name));
    for (const previousName of Object.keys(snapshot.agents ?? {})) {
      if (nextNames.has(previousName)) continue;
      await bindings.putSkillConfig(teamName, previousName, []);
      await bindings.putMcpConfig(teamName, previousName, []);
    }
  }

  private async restoreMaterialization(
    teamName: string,
    blueprint: AgentBlueprint,
    bindings: AgentBuilderBindings,
    snapshot: MaterializationSnapshot,
  ): Promise<void> {
    if (!snapshot.existed) {
      const teams = await this.agentConfig.listTeams();
      if (teams.teams.some((team) => team.team_name === teamName)) {
        await this.agentConfig.deleteTeam(teamName);
      }
      for (const agent of blueprint.agents) {
        await bindings.putSkillConfig(teamName, agent.name, []);
        await bindings.putMcpConfig(teamName, agent.name, []);
      }
      return;
    }
    const previousAgents = snapshot.agents ?? {};
    if (Object.keys(previousAgents).length > 0) {
      await this.agentConfig.applyTeamPayload(teamName, previousAgents);
    } else {
      const teams = await this.agentConfig.listTeams();
      const wasActive = teams.active_team === teamName;
      await this.agentConfig.deleteTeam(teamName);
      await this.agentConfig.createTeam(teamName);
      if (wasActive) await this.agentConfig.activateTeam(teamName);
    }
    const agentNames = new Set([
      ...Object.keys(previousAgents),
      ...blueprint.agents.map((agent) => agent.name),
    ]);
    for (const agentName of agentNames) {
      await bindings.putSkillConfig(teamName, agentName, snapshot.skills.get(agentName) ?? []);
      await bindings.putMcpConfig(teamName, agentName, snapshot.mcpServers.get(agentName) ?? []);
    }
  }

  private exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const current = this.mutationQueue.then(operation, operation);
    this.mutationQueue = current.then(() => undefined, () => undefined);
    return current;
  }
}

interface MaterializationSnapshot {
  existed: boolean;
  agents: Record<string, AgentConfig> | null;
  skills: Map<string, string[]>;
  mcpServers: Map<string, string[]>;
}

function agentDraftWorkspacePath(workspaceRoot: string, draftId: string): string {
  const root = workspaceRoot.trim();
  if (!root) throw new AgentBuilderConflictError("Current Agent Session has no workspace");
  return path.join(path.resolve(root), ".ragsystem", "agent-builder", "drafts", draftId);
}

async function writeWorkspaceJson(workspacePath: string, fileName: string, value: unknown): Promise<void> {
  await writeFile(path.join(workspacePath, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readWorkspaceJson(workspacePath: string, fileName: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, fileName), "utf8"));
  } catch (error) {
    throw new AgentBuilderValidationError({
      valid: false,
      checked_at: new Date().toISOString(),
      issues: [{ level: "error", code: "workspace_file_unreadable", path: fileName, message: error instanceof Error ? error.message : String(error) }],
    });
  }
}

function parseWorkspaceManifest(value: unknown): { draft_id: string; expected_revision: number } {
  if (!value || typeof value !== "object") throw new AgentBuilderValidationError({
    valid: false,
    checked_at: new Date().toISOString(),
    issues: [{ level: "error", code: "invalid_manifest", path: "manifest.json", message: "manifest.json must be an object" }],
  });
  const record = value as Record<string, unknown>;
  if (typeof record.draft_id !== "string" || !record.draft_id.trim()
    || typeof record.expected_revision !== "number" || !Number.isInteger(record.expected_revision) || record.expected_revision < 1) {
    throw new AgentBuilderValidationError({
      valid: false,
      checked_at: new Date().toISOString(),
      issues: [{ level: "error", code: "invalid_manifest", path: "manifest.json", message: "manifest.json requires draft_id and expected_revision" }],
    });
  }
  return { draft_id: record.draft_id, expected_revision: record.expected_revision };
}

export function validateBlueprint(
  blueprintInput: AgentBlueprint,
  inventory: AgentBuilderCapabilityInventory,
): AgentBuilderValidationReport {
  const blueprint = AgentBlueprintSchema.parse(blueprintInput);
  const issues: AgentBuilderValidationIssue[] = [];
  const names = new Set(blueprint.agents.map((agent) => agent.name));
  if (!names.has(blueprint.entry_agent)) {
    issues.push(issue("error", "missing_entry_agent", "entry_agent", `Entry agent '${blueprint.entry_agent}' is not defined`));
  }
  for (const [index, agent] of blueprint.agents.entries()) {
    for (const delegate of agent.delegates) {
      if (!names.has(delegate)) {
        issues.push(issue("error", "unknown_delegate", `agents.${index}.delegates`, `Delegate '${delegate}' is not defined`));
      }
      if (delegate === agent.name) {
        issues.push(issue("error", "self_delegation", `agents.${index}.delegates`, "An agent cannot delegate to itself"));
      }
    }
    checkBindings(issues, inventory.tools, agent.tools, `agents.${index}.tools`, "unknown_tool", "tool");
    checkBindings(issues, inventory.skills, agent.skills, `agents.${index}.skills`, "unknown_skill", "Skill");
    checkBindings(issues, inventory.mcpServers, agent.mcp_servers, `agents.${index}.mcp_servers`, "unknown_mcp_server", "MCP server");
  }
  const cycle = findDelegationCycle(blueprint.agents);
  if (cycle) {
    issues.push(issue("error", "delegation_cycle", "agents", `Delegation cycle detected: ${cycle.join(" -> ")}`));
  }
  if (blueprint.acceptance_tests.length === 0) {
    issues.push(issue("warning", "missing_acceptance_tests", "acceptance_tests", "No acceptance tests are defined"));
  }
  return {
    valid: !issues.some((item) => item.level === "error"),
    checked_at: new Date().toISOString(),
    issues,
  };
}

function toRuntimeAgent(agent: AgentBlueprintAgent, isEntry: boolean): AgentConfig {
  const llmTiers: Record<string, AgentLlmConfig> | null = agent.llm ? { default: agent.llm } : null;
  return {
    agent_name: agent.name,
    display_name: agent.display_name ?? agent.name,
    description: agent.description,
    enabled: true,
    default_entry: isEntry,
    llm_tiers: llmTiers,
    tools: { enabled_tools: agent.tools },
    goals: { enabled: agent.goals_enabled },
    tasks: { background: agent.background_tasks },
    delegation: { enabled_agents: agent.delegates },
    custom_params: {
      type: isEntry && agent.delegates.length > 0 ? "orchestrator" : "general",
      behavior: {
        system_prompt: agent.instructions,
        compression_trigger_ratio: 0.85,
        summarize_max_tokens: 300,
        preserve_recent_turns: 3,
      },
    },
  };
}

function assertRevision(draft: AgentDraft, expectedRevision: number): void {
  if (draft.revision !== expectedRevision) {
    throw new AgentBuilderConflictError(`Draft revision conflict: expected ${expectedRevision}, current ${draft.revision}`);
  }
}

function checkBindings(
  issues: AgentBuilderValidationIssue[],
  available: ReadonlySet<string> | undefined,
  requested: readonly string[],
  path: string,
  code: string,
  label: string,
): void {
  if (!available) return;
  for (const name of requested) {
    if (!available.has(name)) issues.push(issue("error", code, path, `${label} '${name}' is not available`));
  }
}

function findDelegationCycle(agents: readonly AgentBlueprintAgent[]): string[] | null {
  const graph = new Map(agents.map((agent) => [agent.name, agent.delegates]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (active.has(name)) {
      const start = path.indexOf(name);
      return [...path.slice(start), name];
    }
    if (visited.has(name)) return null;
    visited.add(name);
    active.add(name);
    path.push(name);
    for (const next of graph.get(name) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

function issue(
  level: "error" | "warning",
  code: string,
  path: string,
  message: string,
): AgentBuilderValidationIssue {
  return { level, code, path, message };
}
