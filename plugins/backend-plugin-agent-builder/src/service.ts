import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, AgentConfigPort, AgentLlmConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { SystemConfigPort } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

import {
  AgentBlueprintSchema,
  AgentBlueprintAgentSchema,
  AgentDraftSchema,
  type AgentBlueprint,
  type AgentBlueprintAgent,
  type AgentBuilderCapabilityInventory,
  type AgentBuilderValidationIssue,
  type AgentBuilderValidationReport,
  type AgentDraft,
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
    private readonly agentConfig: AgentConfigPort,
    private readonly pluginTools: readonly BackendToolDescriptor[] = [],
    private readonly systemConfig: SystemConfigPort | null = null,
  ) {}

  getAgentConfigPort(): AgentConfigPort {
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

  createDraft(
    blueprintInput: AgentBlueprint,
    validation: AgentBuilderValidationReport | null = null,
    options: { sourceTeamName?: string | null; status?: "draft" | "published" } = {},
  ): Promise<AgentDraft> {
    return this.exclusive(() => this.createDraftUnlocked(blueprintInput, validation, options));
  }

  private async createDraftUnlocked(
    blueprintInput: AgentBlueprint,
    validation: AgentBuilderValidationReport | null,
    options: { sourceTeamName?: string | null; status?: "draft" | "published" },
  ): Promise<AgentDraft> {
    const now = new Date().toISOString();
    const blueprint = AgentBlueprintSchema.parse(blueprintInput);
    const existing = (await this.store.listDrafts()).find((draft) => draft.blueprint.name === blueprint.name) ?? null;
    if (existing) throw new AgentBuilderConflictError(`An Agent draft already targets '${blueprint.name}'`);
    const draft = AgentDraftSchema.parse({
      id: `draft_${randomUUID().replaceAll("-", "")}`,
      revision: 1,
      status: options.status ?? "draft",
      source_team_name: options.sourceTeamName?.trim() || null,
      blueprint,
      validation,
      published_at: options.status === "published" ? now : null,
      created_at: now,
      updated_at: now,
    });
    await this.store.putDraft(draft);
    return draft;
  }

  async createDraftForEditing(
    blueprintInput: AgentBlueprint,
    bindings: AgentBuilderBindings,
  ): Promise<AgentDraft> {
    const blueprint = AgentBlueprintSchema.parse(blueprintInput);
    const existing = (await this.store.listDrafts()).find((draft) => draft.blueprint.name === blueprint.name) ?? null;
    if (existing) throw new AgentBuilderConflictError(`An Agent draft already targets '${blueprint.name}'`);
    const teams = await this.agentConfig.listTeams();
    if (teams.teams.some((team) => team.team_name === blueprint.name)) {
      const synchronized = await this.synchronizeTeamDraft(blueprint.name, bindings);
      if (synchronized) return synchronized;
    }
    return this.createDraft(blueprint);
  }

  synchronizeTeamDraft(
    teamName: string,
    bindings: AgentBuilderBindings,
    options: { previousTeamName?: string | null } = {},
  ): Promise<AgentDraft | null> {
    return this.exclusive(async () => {
      const normalizedTeamName = teamName.trim();
      if (!normalizedTeamName) throw new AgentBuilderConflictError("Team name is required for Draft synchronization");
      const configs = this.agentConfig.listConfigs({ teamName: normalizedTeamName });
      if (Object.keys(configs).length === 0) return null;

      const drafts = await this.store.listDrafts();
      const linked = drafts.find((draft) => draft.source_team_name === normalizedTeamName) ?? null;
      const renamedDraft = options.previousTeamName?.trim()
        ? drafts.find((draft) => draft.source_team_name === options.previousTeamName?.trim()) ?? null
        : null;
      const blueprintName = blueprintNameFromTeam(normalizedTeamName);
      const editableByName = linked || renamedDraft
        ? null
        : drafts.find((draft) => draft.source_team_name === null
          && draft.blueprint.name === blueprintName
          && draft.status !== "published") ?? null;
      const current = linked ?? renamedDraft ?? editableByName;
      const blueprint = await teamConfigToBlueprint(
        normalizedTeamName,
        blueprintName,
        configs,
        current?.blueprint ?? null,
        bindings,
      );

      if (current) {
        if (current.status === "published"
          && current.source_team_name === normalizedTeamName
          && sameBlueprint(current.blueprint, blueprint)) {
          return current;
        }
        const updated = AgentDraftSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: "published",
          source_team_name: normalizedTeamName,
          blueprint,
          validation: null,
          published_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        await this.store.putDraft(updated);
        return updated;
      }

      return this.createDraftUnlocked(blueprint, null, {
        sourceTeamName: normalizedTeamName,
        status: "published",
      });
    });
  }

  restoreDraftAfterTeamDelete(teamName: string): Promise<AgentDraft | null> {
    return this.exclusive(async () => {
      const normalizedTeamName = teamName.trim();
      if (!normalizedTeamName) throw new AgentBuilderConflictError("Team name is required for Draft restoration");
      const drafts = await this.store.listDrafts();
      const linked = drafts.find((draft) => draft.source_team_name === normalizedTeamName) ?? null;
      if (!linked) return null;

      const restored = AgentDraftSchema.parse({
        ...linked,
        revision: linked.revision + 1,
        status: "draft",
        source_team_name: null,
        validation: null,
        published_at: null,
        updated_at: new Date().toISOString(),
      });
      await this.store.putDraft(restored);
      return restored;
    });
  }

  async createWorkspaceDraft(
    name: string,
    description: string,
    workspaceRoot: string,
    bindings?: AgentBuilderBindings,
  ): Promise<{ draft: AgentDraft; workspacePath: string }> {
    const blueprint = AgentBlueprintSchema.parse({
      schema_version: 1,
      name,
      description,
      entry_agent: "main",
      agents: [{
        name: "main",
        description: "Primary entry agent",
        instructions: "Define the agent instructions in this blueprint before publishing.",
        enabled: true,
        tools: [],
        skills: [],
        mcp_servers: [],
        delegates: [],
        goals_enabled: false,
        background_tasks: false,
        custom_params: {},
      }],
    });
    const draft = bindings
      ? await this.createDraftForEditing(blueprint, bindings)
      : await this.createDraft(blueprint);
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
  ): Promise<{ draft: AgentDraft; auto_published: boolean; workspacePath: string }> {
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

    const autoPublished = this.isAutoPublishEnabled();
    const result = autoPublished
      ? await this.publishBlueprint(current.id, current.revision, blueprint, validation, bindings)
      : await this.updateDraft(current.id, current.revision, blueprint, validation);
    await this.materializeDraftToWorkspace(result, workspaceRoot);
    return { draft: result, auto_published: autoPublished, workspacePath: agentDraftWorkspacePath(workspaceRoot, result.id) };
  }

  isAutoPublishEnabled(): boolean {
    const approval = this.systemConfig
      ? resolveAgentBuilderApprovalConfig(
        this.systemConfig.getSection("agent_builder"),
      )
      : { auto_publish_candidates: false };
    return approval.auto_publish_candidates;
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
      const blueprint = AgentBlueprintSchema.parse(blueprintInput);
      if (current.source_team_name && blueprint.name !== current.blueprint.name) {
        throw new AgentBuilderConflictError("Published Team names are immutable; create a separate Draft for a rename");
      }
      const updated = AgentDraftSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "draft",
        blueprint,
        validation,
        updated_at: new Date().toISOString(),
      });
      await this.store.putDraft(updated);
      return updated;
    });
  }

  deleteDraft(id: string): Promise<{ id: string }> {
    return this.exclusive(async () => {
      await this.getDraft(id);
      await this.store.deleteDraft(id);
      return { id };
    });
  }

  async autoApproveDraft(
    draft: AgentDraft,
    bindingsProvider: () => Promise<AgentBuilderBindings>,
  ): Promise<AgentDraft> {
    const approval = this.systemConfig
      ? resolveAgentBuilderApprovalConfig(
        this.systemConfig.getSection("agent_builder"),
      )
      : { auto_publish_candidates: false };
    if (!approval.auto_publish_candidates || draft.status === "published") return draft;
    await this.publishDraft(draft.id, draft.revision, await bindingsProvider());
    return this.getDraft(draft.id);
  }

  publishDraft(id: string, expectedRevision: number, bindings: AgentBuilderBindings): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      assertRevision(current, expectedRevision);
      if (current.status === "published" && current.source_team_name) {
        const teams = await this.agentConfig.listTeams();
        if (teams.teams.some((team) => team.team_name === current.source_team_name)) return current;
      }
      const validation = validateBlueprint(current.blueprint, bindings.inventory);
      if (!validation.valid) {
        throw new AgentBuilderValidationError(validation);
      }
      return this.publishValidatedBlueprint(current, current.blueprint, validation, bindings);
    });
  }

  private publishBlueprint(
    id: string,
    expectedRevision: number,
    blueprint: AgentBlueprint,
    validation: AgentBuilderValidationReport,
    bindings: AgentBuilderBindings,
  ): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      assertRevision(current, expectedRevision);
      if (current.source_team_name && blueprint.name !== current.blueprint.name) {
        throw new AgentBuilderConflictError("Published Team names are immutable; create a separate Draft for a rename");
      }
      return this.publishValidatedBlueprint(current, blueprint, validation, bindings);
    });
  }

  private async publishValidatedBlueprint(
    current: AgentDraft,
    blueprint: AgentBlueprint,
    validation: AgentBuilderValidationReport,
    bindings: AgentBuilderBindings,
  ): Promise<AgentDraft> {
      const runtimeTeamName = current.source_team_name ?? blueprint.name;
      const teams = await this.agentConfig.listTeams();
      const teamExists = teams.teams.some((team) => team.team_name === runtimeTeamName);
      if (current.status === "published" && teamExists && sameBlueprint(current.blueprint, blueprint)) return current;

      if (!current.source_team_name && teamExists) {
        throw new AgentBuilderConflictError(
          `Team '${runtimeTeamName}' already exists; publishing a new Draft will not overwrite it`,
        );
      }
      const publishedAt = new Date().toISOString();
      const rollback = await this.captureMaterialization(runtimeTeamName, bindings);
      try {
        await this.materialize(runtimeTeamName, blueprint, bindings, rollback);
        const published = AgentDraftSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: "published",
          source_team_name: runtimeTeamName,
          blueprint,
          validation,
          published_at: publishedAt,
          updated_at: publishedAt,
        });
        await this.store.putDraft(published);
        return published;
      } catch (error) {
        try {
          await this.restoreMaterialization(runtimeTeamName, blueprint, bindings, rollback);
        } catch (materializationRollbackError) {
          throw new AggregateError([error, materializationRollbackError], "Agent publish failed and rollback was incomplete");
        }
        throw error;
      }
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
  return {
    valid: !issues.some((item) => item.level === "error"),
    checked_at: new Date().toISOString(),
    issues,
  };
}

async function teamConfigToBlueprint(
  teamName: string,
  blueprintName: string,
  configs: Record<string, AgentConfig>,
  basis: AgentBlueprint | null,
  bindings: AgentBuilderBindings,
): Promise<AgentBlueprint> {
  const entries = Object.entries(configs);
  const entryAgent = entries.find(([, config]) => config.default_entry)?.[0] ?? entries[0]![0];
  const agents = await Promise.all(entries.map(async ([name, config]) => {
    return AgentBlueprintAgentSchema.parse({
      name,
      display_name: config.display_name,
      description: config.description?.trim() ?? null,
      instructions: agentInstructions(config),
      enabled: config.enabled,
      llm_tiers: config.llm_tiers,
      tools: config.tools.enabled_tools,
      skills: await bindings.getSkillConfig(teamName, name),
      mcp_servers: await bindings.getMcpConfig(teamName, name),
      delegates: config.delegation.enabled_agents,
      goals_enabled: config.goals.enabled,
      background_tasks: config.tasks.background,
      custom_params: config.custom_params,
    });
  }));
  return AgentBlueprintSchema.parse({
    schema_version: 1,
    name: blueprintName,
    description: basis?.description ?? `Configuration synchronized from Team '${teamName}'.`,
    entry_agent: entryAgent,
    agents,
  });
}

function agentInstructions(config: AgentConfig): string {
  const behavior = isRecord(config.custom_params.behavior)
    ? config.custom_params.behavior
    : null;
  const prompt = typeof behavior?.system_prompt === "string"
    ? behavior.system_prompt.trim()
    : "";
  return prompt || config.description?.trim() || `Act as ${config.display_name?.trim() || config.agent_name}.`;
}

function blueprintNameFromTeam(teamName: string): string {
  const normalized = teamName.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 64);
  return normalized || "team-draft";
}

function sameBlueprint(left: AgentBlueprint, right: AgentBlueprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toRuntimeAgent(agent: AgentBlueprintAgent, isEntry: boolean): AgentConfig {
  const llmTiers: Record<string, AgentLlmConfig> | null = agent.llm_tiers !== undefined
    ? agent.llm_tiers
    : agent.llm ? { default: agent.llm } : null;
  const behavior = isRecord(agent.custom_params.behavior) ? agent.custom_params.behavior : {};
  return {
    agent_name: agent.name,
    display_name: agent.display_name === undefined ? agent.name : agent.display_name,
    description: agent.description,
    enabled: agent.enabled,
    default_entry: isEntry,
    llm_tiers: llmTiers,
    tools: { enabled_tools: agent.tools },
    goals: { enabled: agent.goals_enabled },
    tasks: { background: agent.background_tasks },
    delegation: { enabled_agents: agent.delegates, parallel_children: false },
    custom_params: {
      ...agent.custom_params,
      type: agent.custom_params.type ?? (isEntry && agent.delegates.length > 0 ? "orchestrator" : "general"),
      behavior: {
        ...behavior,
        system_prompt: agent.instructions,
        compression_trigger_ratio: behavior.compression_trigger_ratio ?? 0.85,
        summarize_max_tokens: behavior.summarize_max_tokens ?? 30000,
        preserve_recent_turns: behavior.preserve_recent_turns ?? 3,
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
