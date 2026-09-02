import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, AgentConfigPort, AgentLlmConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { ModelProviderCatalogPort } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { AgentCapabilityProvider } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { SystemConfigPort } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import { findProviderByRef } from "@ragsystem/backend-core/services/runtime/provider-lookup.js";

import {
  AgentBlueprintAgentSchema,
  AgentBlueprintSchema,
  AgentDraftSchema,
  parseBlueprint,
  type AgentBlueprint,
  type AgentBlueprintAgent,
  type AgentBuilderCapabilityInventory,
  type AgentBuilderValidationIssue,
  type AgentBuilderValidationReport,
  type AgentDraft,
} from "./contracts.js";
import type { AgentBuilderStore } from "./store.js";
import { BLUEPRINT_SCHEMA_GUIDE } from "./schema-guide.js";
import { resolveAgentBuilderApprovalConfig } from "./config.js";

export interface AgentBuilderBindings {
  readonly inventory: AgentBuilderCapabilityInventory;
  readonly providers: readonly AgentCapabilityProvider[];
}

/** 发布 revision 与其物化团队哈希的对照（失败回流按快照哈希归因发布版本）。 */
export interface AgentPublishedTeamRevision {
  readonly team_name: string;
  readonly draft_id: string;
  readonly revision: number;
  readonly team_revision_hash: string;
  readonly published_at: string | null;
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
    private readonly modelAdapter: ModelProviderCatalogPort | null = null,
  ) {}

  getAgentConfigPort(): AgentConfigPort {
    return this.agentConfig;
  }

  getModelAdapterPort(): ModelProviderCatalogPort | null {
    return this.modelAdapter;
  }

  /** 已发布 revision 的团队哈希清单（含历史 revision）：快照哈希 → 发布版本归因的数据源。 */
  async listPublishedTeamRevisions(): Promise<readonly AgentPublishedTeamRevision[]> {
    const links: AgentPublishedTeamRevision[] = [];
    for (const draft of await this.store.listDrafts()) {
      if (!draft.source_team_name) continue;
      const records: AgentDraft[] = [draft];
      for (const revision of await this.store.listRevisions(draft.id)) {
        const record = await this.store.getRevision(draft.id, revision);
        if (record) records.push(record);
      }
      for (const record of records) {
        if (record.status !== "published" || !record.source_team_name || !record.team_revision_hash) continue;
        links.push({
          team_name: record.source_team_name,
          draft_id: record.id,
          revision: record.revision,
          team_revision_hash: record.team_revision_hash,
          published_at: record.published_at,
        });
      }
    }
    return links.sort((left, right) => left.revision - right.revision);
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
    blueprintInput: unknown,
    validation: AgentBuilderValidationReport | null = null,
    options: { sourceTeamName?: string | null; status?: "draft" | "published" } = {},
  ): Promise<AgentDraft> {
    return this.exclusive(() => this.createDraftUnlocked(blueprintInput, validation, options));
  }

  private async createDraftUnlocked(
    blueprintInput: unknown,
    validation: AgentBuilderValidationReport | null,
    options: { sourceTeamName?: string | null; status?: "draft" | "published" },
  ): Promise<AgentDraft> {
    const now = new Date().toISOString();
    const blueprint = parseBlueprint(blueprintInput);
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
    blueprintInput: unknown,
    bindings: AgentBuilderBindings,
  ): Promise<AgentDraft> {
    const blueprint = parseBlueprint(blueprintInput);
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
          // 同步自团队当前内容：哈希重读当前值。蓝图就是从这份团队内容派生的，
          // 哈希与蓝图同源，归因映射（哈希→revision）才不会指到旧发布的内容上。
          team_revision_hash: (await this.agentConfig.listTeams())
            .teams.find((team) => team.team_name === normalizedTeamName)?.team_revision ?? null,
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
        team_revision_hash: null,
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
    const blueprint = parseBlueprint({
      schema_version: 2,
      name,
      description,
      entry_agent: "main",
      acceptance: [],
      agents: [{
        name: "main",
        description: "Primary entry agent",
        instructions: "Define the agent instructions in this blueprint before publishing.",
        enabled: true,
        tools: [],
        capabilities: {},
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
    await writeFile(path.join(workspacePath, "blueprint.schema.md"), BLUEPRINT_SCHEMA_GUIDE, "utf8");
    return { draft, workspacePath };
  }

  /** 只校验不发布：读取工作区蓝图并返回 publish 同款校验报告，供编辑过程中随时自查。 */
  async validateWorkspaceDraft(
    draftId: string,
    workspaceRoot: string,
    bindings: AgentBuilderBindings,
  ): Promise<AgentBuilderValidationReport> {
    try {
      const { blueprint } = await this.readWorkspaceBlueprint(draftId, workspaceRoot);
      return validateBlueprint(blueprint, bindings.inventory);
    } catch (error) {
      // NotFound 与 Conflict 原样抛出（草稿/工作区缺失不是蓝图格式问题）；
      // ValidationError（blueprint.json 解析失败）转报告，兑现「随时返回校验报告」的工具契约
      if (error instanceof AgentBuilderValidationError) {
        return error.report;
      }
      if (error instanceof AgentBuilderConflictError || error instanceof AgentBuilderNotFoundError) throw error;
      return {
        valid: false,
        checked_at: new Date().toISOString(),
        issues: [{
          level: "error",
          code: "invalid_blueprint",
          path: "blueprint.json",
          message: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  }

  /**
   * 读取当前会话工作区正在编辑的蓝图（manifest draft_id 校验 + revision 乐观锁检查）。
   * validate / publish / try 共用同一读取口径：试运行试的就是所见即所得的工作区版本。
   * 返回蓝图与所基于的草稿 revision，供试用报告追溯试的是哪个版本。
   */
  async readWorkspaceBlueprint(draftId: string, workspaceRoot: string): Promise<{ blueprint: AgentBlueprint; revision: number }> {
    const current = await this.getDraft(draftId);
    const workspacePath = agentDraftWorkspacePath(workspaceRoot, draftId);
    const manifest = parseWorkspaceManifest(await readWorkspaceJson(workspacePath, "manifest.json"));
    if (manifest.draft_id !== draftId) throw new AgentBuilderConflictError("Workspace manifest draft_id does not match the requested draft");
    assertRevision(current, manifest.expected_revision);
    try {
      const blueprint = parseBlueprint(await readWorkspaceJson(workspacePath, "blueprint.json"));
      return { blueprint, revision: current.revision };
    } catch (error) {
      throw new AgentBuilderValidationError({
        valid: false,
        checked_at: new Date().toISOString(),
        issues: [{ level: "error", code: "invalid_blueprint", path: "blueprint.json", message: error instanceof Error ? error.message : String(error) }],
      });
    }
  }

  async publishWorkspaceDraft(
    draftId: string,
    workspaceRoot: string,
    bindings: AgentBuilderBindings,
  ): Promise<{ draft: AgentDraft; auto_published: boolean; workspacePath: string }> {
    const current = await this.getDraft(draftId);
    const workspacePath = agentDraftWorkspacePath(workspaceRoot, draftId);
    const { blueprint } = await this.readWorkspaceBlueprint(draftId, workspaceRoot);
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
      : { auto_publish_candidates: true };
    return approval.auto_publish_candidates;
  }

  updateDraft(
    id: string,
    expectedRevision: number,
    blueprintInput: unknown,
    validation: AgentBuilderValidationReport | null = null,
  ): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      assertRevision(current, expectedRevision);
      const blueprint = parseBlueprint(blueprintInput);
      if (current.source_team_name && blueprint.name !== current.blueprint.name) {
        throw new AgentBuilderConflictError("Published Team names are immutable; create a separate Draft for a rename");
      }
      const updated = AgentDraftSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "draft",
        blueprint,
        validation,
        // 编辑态 revision 不对应任何已发布团队内容：清掉旧哈希，防止归因指向过时版本
        team_revision_hash: null,
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

  listDraftRevisions(id: string): Promise<number[]> {
    return this.exclusive(async () => {
      await this.getDraft(id);
      return this.store.listRevisions(id);
    });
  }

  /** 回滚 = 以历史 revision 的蓝图生成新的当前 revision（编辑态），历史档不删，可继续回滚。 */
  rollbackDraft(id: string, expectedRevision: number, toRevision: number): Promise<AgentDraft> {
    return this.exclusive(async () => {
      const current = await this.getDraft(id);
      assertRevision(current, expectedRevision);
      if (toRevision >= current.revision) {
        throw new AgentBuilderConflictError(
          `Revision ${toRevision} is not older than the current revision ${current.revision}`,
        );
      }
      const snapshot = await this.store.getRevision(id, toRevision);
      if (!snapshot) {
        throw new AgentBuilderNotFoundError(`Revision ${toRevision} of Agent draft '${id}' does not exist`);
      }
      const restored = AgentDraftSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "draft",
        blueprint: snapshot.blueprint,
        validation: null,
        published_at: null,
        team_revision_hash: null,
        updated_at: new Date().toISOString(),
      });
      await this.store.putDraft(restored);
      return restored;
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
      : { auto_publish_candidates: true };
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
        // 记录发布时刻的团队内容哈希：会话团队快照哈希由此映射回发布 revision（失败回流归因用）。
        // 显式置空覆盖 current 里的旧哈希，防止陈旧哈希错挂到新 revision。
        const teamRevisionHash = (await this.agentConfig.listTeams())
          .teams.find((team) => team.team_name === runtimeTeamName)?.team_revision ?? null;
        const published = AgentDraftSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: "published",
          source_team_name: runtimeTeamName,
          blueprint,
          validation,
          published_at: publishedAt,
          updated_at: publishedAt,
          team_revision_hash: teamRevisionHash,
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
    const capabilities = new Map<string, ReadonlyMap<string, string[]>>();
    if (existed) {
      for (const agentName of Object.keys(agents ?? {})) {
        const perProvider = new Map<string, string[]>();
        for (const provider of bindings.providers) {
          perProvider.set(provider.id, [...await provider.getAgentConfig(teamName, agentName)]);
        }
        capabilities.set(agentName, perProvider);
      }
    }
    return { existed, agents, capabilities };
  }

  private async materialize(
    teamName: string,
    blueprint: AgentBlueprint,
    bindings: AgentBuilderBindings,
    snapshot: MaterializationSnapshot,
  ): Promise<void> {
    // 蓝图 tier 允许省略 provider_type（schema 可选），但运行时 readiness 要求它非空——
    // 缺失即「能过校验、能发布、必跑挂」。物化前按模型目录回填，publish 与 trial 共用。
    const expanded = this.expandBlueprintLlmTiers(blueprint);
    await this.agentConfig.applyTeamPayload(
      teamName,
      Object.fromEntries(expanded.agents.map((agent) => [
        agent.name,
        toRuntimeAgent(agent, agent.name === expanded.entry_agent),
      ])),
    );
    for (const agent of expanded.agents) {
      for (const provider of bindings.providers) {
        await provider.putAgentConfig(teamName, agent.name, agent.capabilities[provider.id] ?? []);
      }
    }
    const nextNames = new Set(expanded.agents.map((agent) => agent.name));
    for (const previousName of Object.keys(snapshot.agents ?? {})) {
      if (nextNames.has(previousName)) continue;
      for (const provider of bindings.providers) {
        await provider.putAgentConfig(teamName, previousName, []);
      }
    }
  }

  /** tier 快照的 provider_type 回填：provider 按 name/key 可唯一匹配时补全缺失的 provider_type。 */
  expandBlueprintLlmTiers(blueprint: AgentBlueprint): AgentBlueprint {
    const providers = this.modelAdapter?.listProviders() ?? [];
    if (providers.length === 0) return blueprint;
    const expandTier = (tier: AgentLlmConfig): AgentLlmConfig => {
      const providerType = typeof tier.provider_type === "string" ? tier.provider_type.trim() : "";
      if (providerType || !tier.provider?.trim()) return tier;
      const matched = findProviderByRef(providers, { provider: tier.provider ?? null, provider_type: null });
      return matched ? { ...tier, provider_type: matched.provider_type } : tier;
    };
    return {
      ...blueprint,
      agents: blueprint.agents.map((agent) => {
        if (agent.llm_tiers) {
          return {
            ...agent,
            llm_tiers: Object.fromEntries(Object.entries(agent.llm_tiers).map(([tier, config]) => [
              tier,
              expandTier(config),
            ])),
          };
        }
        if (agent.llm) return { ...agent, llm: expandTier(agent.llm) };
        return agent;
      }),
    };
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
        for (const provider of bindings.providers) {
          await provider.putAgentConfig(teamName, agent.name, []);
        }
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
      // 遗留非规范名存量团队也必须能完整回滚，跳过创建通道的命名校验。
      await this.agentConfig.createTeam(teamName, null, { allowLegacyName: true });
      if (wasActive) await this.agentConfig.activateTeam(teamName);
    }
    const agentNames = new Set([
      ...Object.keys(previousAgents),
      ...blueprint.agents.map((agent) => agent.name),
    ]);
    for (const agentName of agentNames) {
      const previous = snapshot.capabilities.get(agentName);
      for (const provider of bindings.providers) {
        await provider.putAgentConfig(teamName, agentName, previous?.get(provider.id) ?? []);
      }
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
  capabilities: Map<string, ReadonlyMap<string, string[]>>;
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
  blueprintInput: unknown,
  inventory: AgentBuilderCapabilityInventory,
): AgentBuilderValidationReport {
  const blueprint = parseBlueprint(blueprintInput);
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
    if (agent.llm_tiers == null && agent.llm == null) {
      issues.push(issue(
        "warning",
        "missing_llm_tiers",
        `agents.${index}.llm_tiers`,
        `Agent '${agent.name}' has no llm_tiers or llm configured and will run on the tenant default model`,
      ));
    }
    const llmProviders = inventory.llm_providers;
    if (llmProviders && llmProviders.size > 0 && agent.llm_tiers) {
      for (const [tier, config] of Object.entries(agent.llm_tiers)) {
        // 与运行时 findProviderByRef 同语义：trim+小写后按 name/key 匹配，避免对合法引用误报。
        const provider = config.provider?.trim().toLowerCase();
        if (provider && !llmProviders.has(provider)) {
          issues.push(issue(
            "warning",
            "unknown_llm_provider",
            `agents.${index}.llm_tiers.${tier}`,
            `Provider '${config.provider}' is not in the tenant model catalog (${[...new Set([...llmProviders.keys()])].join(", ")})`,
          ));
        }
      }
    }
    for (const [providerId, requested] of Object.entries(agent.capabilities)) {
      const available = inventory.providers?.get(providerId);
      if (!available) {
        if (requested.length > 0) {
          issues.push(issue(
            "error",
            "unknown_capability_provider",
            `agents.${index}.capabilities.${providerId}`,
            `Capability provider '${providerId}' is not available`,
          ));
        }
        continue;
      }
      for (const name of requested) {
        if (!available.has(name)) {
          issues.push(issue(
            "error",
            "unknown_capability",
            `agents.${index}.capabilities.${providerId}`,
            `Capability '${name}' of provider '${providerId}' is not available`,
          ));
        }
      }
    }
  }
  const cycle = findDelegationCycle(blueprint.agents);
  if (cycle) {
    issues.push(issue("error", "delegation_cycle", "agents", `Delegation cycle detected: ${cycle.join(" -> ")}`));
  }
  const entryIndex = blueprint.agents.findIndex((agent) => agent.name === blueprint.entry_agent);
  const entryAgent = entryIndex >= 0 ? blueprint.agents[entryIndex]! : null;
  if (entryAgent && blueprint.agents.length > 1 && entryAgent.delegates.length > 0 && !hasOwnCapability(entryAgent)) {
    issues.push(issue(
      "warning",
      "router_only_entry_agent",
      `agents.${entryIndex}.tools`,
      `Entry agent '${entryAgent.name}' delegates to sub-agents but has no tools or capabilities of its own; `
        + "the entry agent talks to the user directly, so bind it the tools to resolve routine requests itself instead of routing every turn",
    ));
  }
  if (blueprint.acceptance.length === 0) {
    issues.push(issue(
      "warning",
      "missing_acceptance_cases",
      "acceptance",
      "Blueprint has no acceptance cases; derive them from the real sample requests explored before designing instead of inventing them",
    ));
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
    const capabilities: Record<string, string[]> = {};
    for (const provider of bindings.providers) {
      capabilities[provider.id] = [...await provider.getAgentConfig(teamName, name)];
    }
    return AgentBlueprintAgentSchema.parse({
      name,
      display_name: config.display_name,
      description: config.description?.trim() ?? null,
      instructions: agentInstructions(config),
      enabled: config.enabled,
      llm_tiers: config.llm_tiers,
      tools: config.tools.enabled_tools,
      capabilities,
      delegates: config.delegation.enabled_agents,
      goals_enabled: config.goals.enabled,
      background_tasks: config.tasks.background,
      custom_params: blueprintCustomParams(config.custom_params),
    });
  }));
  return AgentBlueprintSchema.parse({
    schema_version: 2,
    name: blueprintName,
    description: basis?.description ?? `Configuration synchronized from Team '${teamName}'.`,
    entry_agent: entryAgent,
    agents,
    // 线上运行时配置不携带验收用例；同步时沿用草稿既有用例，避免重建蓝图时丢掉回归防线。
    acceptance: basis?.acceptance ?? [],
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

/**
 * 蓝图中 instructions 是提示词唯一来源：同步 Team 配置时从 custom_params.behavior
 * 剥离 system_prompt（保留压缩参数等其他字段），避免同一提示词双写两处失同步。
 */
function blueprintCustomParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (!isRecord(value.behavior)) return { ...value };
  const { system_prompt: _dropped, ...behavior } = value.behavior;
  return { ...value, behavior };
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

export { toRuntimeAgent };

function assertRevision(draft: AgentDraft, expectedRevision: number): void {
  if (draft.revision !== expectedRevision) {
    throw new AgentBuilderConflictError(
      `Draft revision conflict: workspace expects revision ${expectedRevision}, current is ${draft.revision}. `
        + "The draft changed elsewhere; call get_agent_draft to refresh this workspace before editing or publishing again",
    );
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

/** 入口 Agent 是否具备自身可用能力：工具或任一 capability provider 的绑定（Skill 运行时会注入执行工具，也算）。 */
function hasOwnCapability(agent: AgentBlueprintAgent): boolean {
  if (agent.tools.length > 0) return true;
  return Object.values(agent.capabilities).some((names) => names.length > 0);
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
