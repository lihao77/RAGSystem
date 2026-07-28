import { isRecord, normalizeString, asString, asRecord } from "../../utils/guards.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { JsonValue } from "../../contracts/common.js";
import { AgentConfigSchema, type AgentConfig } from "../../contracts/agent/agent-config.js";
import type { AgentConfigService } from "../../services/agent/config/index.js";
import type { ArtifactService } from "../../services/artifacts/artifact-service.js";
import type { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import type { ClientEventPublisher } from "../../services/runtime/event-outbox/client-event-publisher.js";
import type { ISkillPackageStore, SkillPackageRecord } from "../../contracts/skills/skill-package-store.js";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";

type SkillSourceType = "workspace" | "user_global" | "builtin";

type SkillIsolationMode = "venv" | "shared";

interface SkillSourceSpec {
  root: string;
  sourceType: SkillSourceType;
  sourceLabel: string;
  isAutoInjectCandidate: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
  skillDir: string;
  metadata: Record<string, unknown>;
  sourceType: SkillSourceType;
  sourceLabel: string;
  isAutoInjectCandidate: boolean;
  originRoot: string;
  requires?: SkillRequires;
}

/** Skill 声明的能力依赖(走官方 Agent Skills 规范的 metadata 扩展字段,逗号分隔字符串)。 */
export interface SkillRequires {
  mcp_servers?: string[];
  tools?: string[];
}

export interface SkillListItem {
  name: string;
  display_name: string;
  description: string;
  source_type: string;
  source_label: string;
  is_auto_inject_candidate: boolean;
}

export interface SkillToolInput {
  skillName: string;
  resourceFile?: string | null;
  scriptName?: string | null;
  arguments?: string[] | null;
  runInBackground?: boolean | null;
  workspaceRoot?: string | null;
}

const SKILL_SOURCE_PRIORITY: Record<SkillSourceType, number> = {
  workspace: 3,
  user_global: 2,
  builtin: 1,
};

const SKILL_SOURCE_LABELS: Record<SkillSourceType, string> = {
  workspace: "工作区",
  user_global: "全局",
  builtin: "内置",
};

export class SkillToolService {
  private readonly dataRoot: string;
  private readonly builtinSkillsRoot: string;
  private readonly userGlobalSkillsRoot: string;

  constructor(
    options: {
      dataRoot?: string | undefined;
      builtinSkillsRoot?: string | undefined;
      userGlobalSkillsRoot?: string | undefined;
      agentConfig?: AgentConfigService | null | undefined;
      artifacts?: ArtifactService | null | undefined;
      backgroundTasks?: BackgroundTaskService | null | undefined;
      clientEvents?: ClientEventPublisher | null | undefined;
      skillIsolationMode?: SkillIsolationMode | undefined;
      /**
       * When set, user_global discovery uses packageStore.list() records (skillDir may be
       * content-addressed). Without it, user_global is scanned under userGlobalSkillsRoot.
       */
      packageStore?: ISkillPackageStore | null | undefined;
    } = {},
  ) {
    if (!options.dataRoot?.trim()) {
      throw new Error("SkillToolService 必须传入已解析的 dataRoot");
    }
    this.dataRoot = path.resolve(options.dataRoot);
    this.builtinSkillsRoot = path.resolve(options.builtinSkillsRoot ?? path.join(process.cwd(), "skills"));
    this.userGlobalSkillsRoot = path.resolve(options.userGlobalSkillsRoot ?? path.join(this.dataRoot, "skills"));
    this.agentConfig = options.agentConfig ?? null;
    this.artifacts = options.artifacts ?? null;
    this.backgroundTasks = options.backgroundTasks ?? null;
    this.clientEvents = options.clientEvents ?? null;
    this.skillIsolationMode = options.skillIsolationMode ?? resolveDefaultIsolationMode();
    this.packageStore = options.packageStore ?? null;
  }

  private readonly agentConfig: AgentConfigService | null;
  private readonly artifacts: ArtifactService | null;
  private readonly backgroundTasks: BackgroundTaskService | null;
  private readonly clientEvents: ClientEventPublisher | null;
  private readonly skillIsolationMode: SkillIsolationMode;
  private readonly packageStore: ISkillPackageStore | null;
  private readonly envLocks = new Map<string, Promise<unknown>>();
  /** Serializes packageStore.list() so concurrent hydrates cannot publish stale snapshots. */
  private hydrateChain: Promise<void> = Promise.resolve();
  /** Last hydrate result from packageStore.list(); only used when packageStore is set. */
  private userGlobalPackageCache: SkillPackageRecord[] = [];

  /**
   * Load tenant user_global packages from packageStore (materialize as needed).
   * When packageStore is set, discovery uses these records instead of scanning userGlobalSkillsRoot.
   * Always re-lists (queued) so create/update/delete observers never keep a coalesced stale snapshot.
   */
  async hydrateUserGlobalPackages(): Promise<void> {
    if (!this.packageStore) return;
    const run = async (): Promise<void> => {
      this.userGlobalPackageCache = await this.packageStore!.list();
    };
    // Chain even after rejection so a failed list does not permanently poison later hydrates.
    this.hydrateChain = this.hydrateChain.then(run, run);
    await this.hydrateChain;
  }

  /** builtin skill 根目录（代码库内置，只读）。 */
  getBuiltinSkillsRoot(): string {
    return this.builtinSkillsRoot;
  }

  /** 用户全局 skill 根目录（dataRoot/skills，可读写）。 */
  getUserGlobalSkillsRoot(): string {
    return this.userGlobalSkillsRoot;
  }

  /** workspace skill 根：<workspaceRoot>/.ragsystem/skills；无 workspaceRoot 返回 null。 */
  resolveWorkspaceSkillsRoot(workspaceRoot?: string | null): string | null {
    const workspace = normalizeString(workspaceRoot);
    return workspace ? path.join(path.resolve(workspace), ".ragsystem", "skills") : null;
  }

  listAvailableSkills(workspaceRoot?: string | null): SkillListItem[] {
    return this.loadAllSkills(workspaceRoot).map((skill) => ({
      name: skill.name,
      display_name: titleCase(skill.name.replaceAll("-", " ")),
      description: skill.description,
      source_type: skill.sourceType,
      source_label: skill.sourceLabel,
      is_auto_inject_candidate: skill.isAutoInjectCandidate,
    }));
  }

  async listAvailableSkillsAsync(workspaceRoot?: string | null): Promise<SkillListItem[]> {
    await this.hydrateUserGlobalPackages();
    return this.listAvailableSkills(workspaceRoot);
  }

  /** 删除 skill 时联动清理所有 AgentConfig 中的 enabled_skills 引用（委托 AgentConfigService）。 */
  async purgeSkillReference(skillName: string): Promise<string[]> {
    return this.agentConfig?.purgeSkillReference(skillName) ?? [];
  }

  hasVisibleSkills(agent: AgentConfig | null, workspaceRoot?: string | null): boolean {
    return this.listVisibleSkills(agent, workspaceRoot).length > 0;
  }

  /**
   * 当前 Agent 可见的 Skill 列表（含 name/description），供 skill 工具自描述其参数 enum 与
   * extended_usage 清单——可见性规则与 activate_skill 运行时校验完全一致。
   */
  listVisibleSkills(agent: AgentConfig | null, workspaceRoot?: string | null): SkillInfo[] {
    return this.resolveVisibleSkills(agent, workspaceRoot ?? resolveAgentWorkspaceRoot(agent));
  }

  async listVisibleSkillsAsync(agent: AgentConfig | null, workspaceRoot?: string | null): Promise<SkillInfo[]> {
    await this.hydrateUserGlobalPackages();
    return this.listVisibleSkills(agent, workspaceRoot);
  }

  async activateSkill(input: SkillToolInput, context: ToolExecContext, agent: AgentConfig | null): Promise<ToolExecutionResult> {
    const toolName = "activate_skill";
    await this.hydrateUserGlobalPackages();
    const workspaceRoot = input.workspaceRoot ?? resolveWorkspaceRoot(context, agent);
    const skill = this.findVisibleSkill(input.skillName, agent, context, workspaceRoot);
    if (!skill) {
      return errorResult(
        `Skill '${input.skillName}' 不存在或当前 Agent 无权使用。可用的 Skills: ${JSON.stringify(this.loadAllSkills(workspaceRoot).map((item) => item.name))}`,
        toolName,
      );
    }
    // 校验 Skill 声明的 MCP 依赖是否在当前 Agent 启用清单内(缺失不阻断,但在结果里提示 agent)。
    const missingMcpServers = resolveMissingMcpServers(skill.requires, agent);
    return successResult(
      {
        skill_name: skill.name,
        description: skill.description,
        main_content: skill.content,
        ...(missingMcpServers.length
          ? {
              missing_mcp_servers: missingMcpServers,
              warning: `本 Skill 声明需要 MCP server: ${missingMcpServers.join(", ")},但当前 Agent 未启用,依赖该 server 的步骤可能失败。`,
            }
          : {}),
      },
      {
        summary: `Skill '${skill.name}' 已激活，加载主文件 ${skill.content.length} 字符`,
        outputType: "markdown",
        metadata: {
          content_length: skill.content.length,
          activation_time: "now",
          status: "activated",
          source_type: skill.sourceType,
          source_label: skill.sourceLabel,
          ...(missingMcpServers.length ? { missing_mcp_servers: missingMcpServers } : {}),
        },
        toolName,
      },
    );
  }

  async loadSkillResource(input: SkillToolInput, context: ToolExecContext, agent: AgentConfig | null): Promise<ToolExecutionResult> {
    const toolName = "load_skill_resource";
    const resourceFile = input.resourceFile?.trim();
    if (!resourceFile) {
      return errorResult("resource_file 不能为空", toolName);
    }
    await this.hydrateUserGlobalPackages();
    const workspaceRoot = input.workspaceRoot ?? resolveWorkspaceRoot(context, agent);
    const skill = this.findVisibleSkill(input.skillName, agent, context, workspaceRoot);
    if (!skill) {
      return errorResult(`Skill '${input.skillName}' 不存在或当前 Agent 无权使用`, toolName);
    }
    const resourcePath = path.resolve(skill.skillDir, resourceFile);
    const scriptsDir = path.join(skill.skillDir, "scripts");
    if (!isPathUnder(resourcePath, skill.skillDir) || isPathUnder(resourcePath, scriptsDir)) {
      return errorResult(`文件 '${resourceFile}' 不存在或无法读取`, toolName);
    }
    if (!fs.existsSync(resourcePath) || !fs.statSync(resourcePath).isFile()) {
      return errorResult(`文件 '${resourceFile}' 不存在或无法读取`, toolName);
    }
    const content = fs.readFileSync(resourcePath, "utf8");
    return successResult(
      {
        file_name: resourceFile,
        content,
        skill: skill.name,
      },
      {
        summary: `成功加载 ${resourceFile} (${content.length} 字符)`,
        outputType: "markdown",
        metadata: {
          length: content.length,
        },
        toolName,
      },
    );
  }

  async executeSkillScript(input: SkillToolInput, context: ToolExecContext, agent: AgentConfig | null): Promise<ToolExecutionResult> {
    const toolName = "execute_skill_script";
    const scriptName = input.scriptName?.trim();
    if (!scriptName) {
      return errorResult("script_name 不能为空", toolName);
    }
    await this.hydrateUserGlobalPackages();
    const workspaceRoot = input.workspaceRoot ?? resolveWorkspaceRoot(context, agent);
    const skill = this.findVisibleSkill(input.skillName, agent, context, workspaceRoot);
    if (!skill) {
      return errorResult(`Skill '${input.skillName}' 不存在或当前 Agent 无权使用`, toolName);
    }
    const scriptsDir = path.join(skill.skillDir, "scripts");
    if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) {
      return errorResult(`Skill '${skill.name}' 没有 scripts 目录`, toolName);
    }
    const scriptPath = path.resolve(scriptsDir, scriptName);
    if (!isPathUnder(scriptPath, scriptsDir) || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
      return errorResult(`脚本不存在: ${scriptName}`, toolName);
    }
    if (input.runInBackground && !agent?.tasks?.background) {
      return errorResult("当前 Agent 未启用 tasks.background，不能使用 run_in_background 后台执行", toolName, {
        skill: skill.name,
        script_name: scriptName,
        background_started: false,
      });
    }
    if (input.runInBackground) {
      return this.executeSkillScriptInBackground(skill, scriptPath, scriptName, input.arguments ?? [], context, agent);
    }

    const scriptResult = await this.runScript(skill, scriptPath, input.arguments ?? [], context);
    const meta: Record<string, unknown> = {
      success: scriptResult.returnCode === 0,
      script_name: scriptName,
      skill: skill.name,
    };
    if (scriptResult.stderr.trim()) {
      meta.stderr = scriptResult.stderr;
    }
    if (scriptResult.stdout.length > 4000) {
      meta.force_artifact = true;
    }

    if (scriptResult.returnCode === 0) {
      const parsed = parseJsonStdout(scriptResult.stdout);
      if (parsed !== null) {
        return await this.normalizeStructuredScriptResult(parsed, scriptName, skill.name, meta, context);
      }
    }

    return successResult(
      {
        script_name: scriptName,
        stdout: scriptResult.stdout,
        stderr: scriptResult.stderr,
        return_code: scriptResult.returnCode,
        skill: skill.name,
      },
      {
        summary: `脚本 ${scriptName} 执行完成（返回码: ${scriptResult.returnCode}）`,
        outputType: "text",
        metadata: meta,
        toolName,
      },
    );
  }

  loadAllSkills(workspaceRoot?: string | null): SkillInfo[] {
    const deduped = new Map<string, SkillInfo>();
    for (const skill of this.loadUserGlobalSkills()) {
      deduped.set(skill.name, skill);
    }
    for (const spec of this.diskSkillSources(workspaceRoot)) {
      for (const skillDir of listSkillDirs(spec.root)) {
        const skill = parseSkill(skillDir, spec);
        if (!skill) {
          continue;
        }
        const existing = deduped.get(skill.name);
        if (existing && SKILL_SOURCE_PRIORITY[existing.sourceType] >= SKILL_SOURCE_PRIORITY[skill.sourceType]) {
          continue;
        }
        deduped.set(skill.name, skill);
      }
    }
    return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * user_global skills: via packageStore records when present (SaaS content-addressed cache
   * or Local filesystem store); otherwise scan userGlobalSkillsRoot by directory name.
   */
  private loadUserGlobalSkills(): SkillInfo[] {
    if (this.packageStore) {
      return this.userGlobalPackageCache.map((record) => skillInfoFromPackageRecord(record, this.userGlobalSkillsRoot));
    }
    const spec: SkillSourceSpec = {
      root: this.userGlobalSkillsRoot,
      sourceType: "user_global",
      sourceLabel: SKILL_SOURCE_LABELS.user_global,
      isAutoInjectCandidate: false,
    };
    const skills: SkillInfo[] = [];
    for (const skillDir of listSkillDirs(spec.root)) {
      const skill = parseSkill(skillDir, spec);
      if (skill) skills.push(skill);
    }
    return skills;
  }

  private findSkill(skillName: string, workspaceRoot?: string | null): SkillInfo | null {
    const normalized = skillName.trim();
    return this.loadAllSkills(workspaceRoot).find((skill) => skill.name === normalized) ?? null;
  }

  private findVisibleSkill(skillName: string, agent: AgentConfig | null, context: ToolExecContext, workspaceRoot?: string | null): SkillInfo | null {
    const normalized = skillName.trim();
    return this.resolveVisibleSkills(agent, workspaceRoot ?? resolveWorkspaceRoot(context, agent)).find((skill) => skill.name === normalized) ?? null;
  }

  private resolveVisibleSkills(agent: AgentConfig | null, workspaceRoot?: string | null): SkillInfo[] {
    const skills = this.loadAllSkills(workspaceRoot);
    const enabled = new Set(agent?.skills.enabled_skills ?? []);
    const isEntry = agent?.default_entry === true;
    return skills.filter((skill) => {
      if (enabled.has(skill.name)) {
        return true;
      }
      return isEntry && skill.sourceType === "workspace";
    });
  }

  private async runScript(
    skill: SkillInfo,
    scriptPath: string,
    args: string[],
    context: ToolExecContext,
  ): Promise<{ stdout: string; stderr: string; returnCode: number }> {
    const environment = await this.ensureSkillEnvironment(skill);
    if ("error" in environment) {
      return { stdout: "", stderr: `环境准备失败: ${environment.error}`, returnCode: 1 };
    }
    return spawnProcess(environment.python, [scriptPath, ...args.map(String)], {
      cwd: skill.skillDir,
      timeoutMs: 30_000,
      timeoutMessage: "脚本执行超时（>30秒）",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        RAG_DATA_ROOT: this.dataRoot,
        ...(context.sessionId ? { RAG_SESSION_ID: context.sessionId } : {}),
      },
    });
  }

  /**
   * 准备 Skill 运行所需的 Python 环境，返回应使用的解释器路径。
   *
   * - shared 模式或无 requirements.txt：直接使用系统/共享解释器。
   * - venv 模式且存在 requirements.txt：在 skill 目录下维护 .venv，并按
   *   .installed marker 与 requirements.txt 的 mtime 决定是否重装依赖。
   *
   * 同一 skill 目录的环境准备通过 envLocks 串行化，避免并发创建 venv 竞态。
   */
  private async ensureSkillEnvironment(skill: SkillInfo): Promise<{ python: string } | { error: string }> {
    if (this.skillIsolationMode === "shared") {
      return { python: resolvePythonExecutable() };
    }
    const requirementsFile = path.join(skill.skillDir, "requirements.txt");
    if (!fs.existsSync(requirementsFile)) {
      return { python: resolvePythonExecutable() };
    }
    const previous = this.envLocks.get(skill.skillDir) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => prepareVenv(skill.skillDir, requirementsFile));
    this.envLocks.set(skill.skillDir, current.catch(() => undefined));
    return current;
  }

  private executeSkillScriptInBackground(
    skill: SkillInfo,
    scriptPath: string,
    scriptName: string,
    args: string[],
    context: ToolExecContext,
    agent: AgentConfig | null,
  ): ToolExecutionResult {
    const toolName = "execute_skill_script";
    if (!this.backgroundTasks) {
      return errorResult("execute_skill_script 后台执行暂不可用", toolName, {
        skill: skill.name,
        script_name: scriptName,
        background_started: false,
      });
    }
    const sessionId = normalizeString(context.sessionId);
    if (!sessionId) {
      return errorResult("后台执行需要 session_id（无 session_id 时无法路由完成通知）", toolName, {
        skill: skill.name,
        script_name: scriptName,
        background_started: false,
      });
    }
    const outputDir = path.join(this.dataRoot, "sessions", sessionId, "transient");
    const task = this.backgroundTasks.runCallable({
      outputDir,
      description: `${skill.name}/${scriptName}`,
      sessionId,
      runId: normalizeString(context.runId),
      ownerTaskId: normalizeString(context.taskId),
      kind: "callable",
      resultType: "tool_execution_result",
      clientEvents: this.clientEvents,
      run: () => this.executeSkillScript({ skillName: skill.name, scriptName, arguments: args, runInBackground: false }, context, agent),
    });
    return successResult(
      {
        stdout: "",
        stderr: "",
        return_code: null,
        background_task_id: task.task_id,
        background_started: true,
        skill: skill.name,
        script_name: scriptName,
      },
      {
        summary: "后台任务已启动",
        outputType: "json",
        metadata: {
          success: true,
          skill: skill.name,
          script_name: scriptName,
          background_task_id: task.task_id,
          background_started: true,
          background_output_path: toDisplayPath(task.output_path, this.dataRoot),
          background_kind: task.kind,
          cancel_supported: task.cancel_supported,
          run_id: normalizeString(context.runId),
        },
        toolName,
      },
    );
  }

  private async normalizeStructuredScriptResult(
    rawPayload: unknown,
    scriptName: string,
    skillName: string,
    metadata: Record<string, unknown>,
    context: ToolExecContext,
  ): Promise<ToolExecutionResult> {
    let payload = rawPayload;
    let rawArtifact: unknown = null;
    let rawTeam: unknown = null;
    if (isRecord(payload)) {
      if ("artifact" in payload) {
        rawArtifact = payload.artifact;
        delete payload.artifact;
      }
      if ("team" in payload) {
        rawTeam = payload.team;
        delete payload.team;
      }
    }

    const unwrapped = unwrapScriptResponse(payload);
    if (unwrapped.error) {
      return errorResult(unwrapped.error, "execute_skill_script");
    }
    payload = unwrapped.payload;
    Object.assign(metadata, unwrapped.metadata);
    if (isRecord(payload)) {
      if (rawArtifact === null && "artifact" in payload) {
        rawArtifact = payload.artifact;
        delete payload.artifact;
      }
      if (rawTeam === null && "team" in payload) {
        rawTeam = payload.team;
        delete payload.team;
      }
    }

    let outputType = "json";
    let llmHint: string | null = null;
    if (rawArtifact !== null) {
      const artifact = this.applyArtifactProtocol(rawArtifact, context);
      if ("error" in artifact) {
        metadata.artifact_error = artifact.error;
      } else {
        payload = isRecord(payload)
          ? { ...payload, artifact_id: artifact.info.artifact_id, viz_type: artifact.info.viz_type }
          : { data: payload, artifact_id: artifact.info.artifact_id, viz_type: artifact.info.viz_type };
        metadata.artifact_id = artifact.info.artifact_id;
        metadata.artifact_persisted = true;
        outputType = artifact.info.viz_type;
        llmHint = `在 <final_answer> 中插入 [viz:${artifact.info.artifact_id}] 来展示此可视化`;
      }
    }
    if (rawTeam !== null) {
      const team = await this.applyTeamProtocol(rawTeam);
      if ("error" in team) {
        metadata.team_error = team.error;
      } else {
        payload = isRecord(payload) ? { ...payload, ...team.info } : { data: payload, ...team.info };
        metadata.team_name = team.info.team_name;
        metadata.team_action = team.info.action;
        metadata.team_applied = true;
      }
    }
    return successResult(payload, {
      summary: `脚本 ${scriptName} 执行完成（返回结构化 JSON）`,
      outputType,
      metadata: {
        ...metadata,
        script_name: scriptName,
        skill: skillName,
      },
      toolName: "execute_skill_script",
      llmHint,
    });
  }

  private async applyTeamProtocol(rawTeam: unknown): Promise<{ info: Record<string, unknown> } | { error: string }> {
    if (!isRecord(rawTeam)) {
      return { error: "team 字段必须是对象" };
    }
    const action = asString(rawTeam.action) ?? "create_or_replace";
    if (action !== "create_or_replace") {
      return { error: `不支持的 team action: ${action}` };
    }
    const teamName = asString(rawTeam.team_name);
    if (!teamName) {
      return { error: "team.team_name 不能为空" };
    }
    if (!isRecord(rawTeam.agents)) {
      return { error: "team.agents 必须是非空对象" };
    }
    if (!this.agentConfig) {
      return { error: "AgentConfigService 未接入，无法应用 team" };
    }
    try {
      const result = await this.agentConfig.applyTeamPayload(teamName, rawTeam.agents, asString(rawTeam.source_team));
      return {
        info: {
          action,
          team_name: result.team_name,
          source_team: result.source_team,
          agent_count: result.agent_count,
          agents: result.agents,
          applied: true,
        },
      };
    } catch (error) {
      return { error: `应用 team 失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private applyArtifactProtocol(rawArtifact: unknown, context: ToolExecContext): { info: { artifact_id: string; viz_type: string; title: string; version: number } } | { error: string } {
    if (!isRecord(rawArtifact)) {
      return { error: "artifact 字段必须是对象" };
    }
    if (!this.artifacts) {
      return { error: "ArtifactService 未接入，无法持久化 artifact" };
    }
    const action = asString(rawArtifact.action) ?? "create";
    try {
      if (action === "revise") {
        const artifactId = asString(rawArtifact.artifact_id);
        if (!artifactId) {
          return { error: "revise 操作需要 artifact_id" };
        }
        const record = this.artifacts.reviseVisualization({
          artifactId,
          configPatch: toJsonValue(rawArtifact.config ?? {}),
          replace: rawArtifact.replace === true,
        });
        return {
          info: {
            artifact_id: record.artifact_id,
            viz_type: record.viz_type,
            title: record.title,
            version: record.version,
          },
        };
      }
      if (action !== "create") {
        return { error: `不支持的 artifact action: ${action}` };
      }
      const sessionId = normalizeString(context.sessionId);
      if (!sessionId) {
        return { error: "创建 artifact 需要 session_id" };
      }
      const vizType = asString(rawArtifact.viz_type);
      const subType = asString(rawArtifact.sub_type);
      const title = asString(rawArtifact.title) ?? "";
      const config = rawArtifact.config;
      if (!vizType || config === undefined || config === null) {
        return { error: "artifact 需要 viz_type 和 config 字段" };
      }
      if (vizType === "chart") {
        const record = this.artifacts.createChart({
          sessionId,
          chartConfig: toJsonValue(config),
          chartType: subType ?? "bar",
          title,
        });
        return {
          info: {
            artifact_id: record.artifact_id,
            viz_type: record.viz_type,
            title: record.title,
            version: record.version,
          },
        };
      }
      if (vizType === "map") {
        const record = this.artifacts.createMap({
          sessionId,
          mapData: toJsonValue(config),
          mapType: subType ?? "marker",
          title,
        });
        return {
          info: {
            artifact_id: record.artifact_id,
            viz_type: record.viz_type,
            title: record.title,
            version: record.version,
          },
        };
      }
      return { error: `不支持的 viz_type: ${vizType}` };
    } catch (error) {
      return { error: `artifact 持久化失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Disk-scanned sources only. user_global is handled by loadUserGlobalSkills so SaaS
   * by-hash cache dirs are never mistaken for skill names.
   */
  private diskSkillSources(workspaceRoot?: string | null): SkillSourceSpec[] {
    const specs: SkillSourceSpec[] = [];
    const workspace = normalizeString(workspaceRoot);
    if (workspace) {
      specs.push({
        root: path.join(path.resolve(workspace), ".ragsystem", "skills"),
        sourceType: "workspace",
        sourceLabel: SKILL_SOURCE_LABELS.workspace,
        isAutoInjectCandidate: true,
      });
    }
    specs.push({
      root: this.builtinSkillsRoot,
      sourceType: "builtin",
      sourceLabel: SKILL_SOURCE_LABELS.builtin,
      isAutoInjectCandidate: true,
    });
    return specs;
  }
}

function skillInfoFromPackageRecord(record: SkillPackageRecord, originRoot: string): SkillInfo {
  return {
    name: record.name,
    description: record.description,
    content: record.content,
    skillDir: record.skillDir,
    metadata: record.metadata,
    sourceType: "user_global",
    sourceLabel: SKILL_SOURCE_LABELS.user_global,
    isAutoInjectCandidate: false,
    originRoot,
    ...(record.requires ? { requires: record.requires } : {}),
  };
}

export function readSkillToolArguments(value: Record<string, unknown> | undefined): SkillToolInput {
  return {
    skillName: asString(value?.skill_name) ?? asString(value?.skillName) ?? "",
    resourceFile: asString(value?.resource_file) ?? asString(value?.resourceFile),
    scriptName: asString(value?.script_name) ?? asString(value?.scriptName),
    arguments: readStringArray(value?.arguments),
    runInBackground: typeof value?.run_in_background === "boolean"
      ? value.run_in_background
      : typeof value?.runInBackground === "boolean"
        ? value.runInBackground
        : null,
    workspaceRoot: asString(value?.workspace_root) ?? asString(value?.workspaceRoot),
  };
}

function parseSkill(skillDir: string, spec: SkillSourceSpec): SkillInfo | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = fs.readFileSync(skillFile, "utf8");
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(content);
  if (!match) {
    return null;
  }
  const metadata = parseSkillMetadata(match[1] ?? "");
  const name = asString(metadata.name);
  const description = asString(metadata.description);
  if (!name || !description) {
    return null;
  }
  const info: SkillInfo = {
    name,
    description,
    content: (match[2] ?? "").trim(),
    skillDir,
    metadata,
    sourceType: spec.sourceType,
    sourceLabel: spec.sourceLabel,
    isAutoInjectCandidate: spec.isAutoInjectCandidate,
    originRoot: spec.root,
  };
  const requires = readSkillRequires(metadata);
  if (requires) {
    info.requires = requires;
  }
  return info;
}

/** 从官方 metadata 扩展字段读 Skill 依赖(ragsystem_requires_mcp_servers/ragsystem_requires_tools,逗号分隔)。 */
function readSkillRequires(metadata: Record<string, unknown>): SkillRequires | undefined {
  const metaField = isRecord(metadata.metadata) ? metadata.metadata : null;
  if (!metaField) return undefined;
  const mcpServers = parseCsvString(metaField.ragsystem_requires_mcp_servers);
  const tools = parseCsvString(metaField.ragsystem_requires_tools);
  if (!mcpServers.length && !tools.length) return undefined;
  const requires: SkillRequires = {};
  if (mcpServers.length) requires.mcp_servers = mcpServers;
  if (tools.length) requires.tools = tools;
  return requires;
}

function parseCsvString(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

/** Skill 声明依赖的 MCP server 中,当前 Agent 未启用的(缺失不阻断,仅提示)。 */
function resolveMissingMcpServers(requires: SkillRequires | undefined, agent: AgentConfig | null): string[] {
  const required = requires?.mcp_servers;
  if (!required?.length) return [];
  const enabled = new Set((agent?.mcp?.enabled_servers ?? []).map((server) => server.trim()).filter(Boolean));
  return required.filter((server) => !enabled.has(server));
}

function parseSkillMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    const result: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) {
        continue;
      }
      result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return result;
  }
}

function listSkillDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function parseJsonStdout(stdout: string): unknown | null {
  const text = stdout.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function unwrapScriptResponse(payload: unknown): { payload: unknown; error: string | null; metadata: Record<string, unknown> } {
  if (!isRecord(payload) || !("success" in payload) || !("data" in payload)) {
    return { payload, error: null, metadata: {} };
  }
  if (payload.success === false) {
    return {
      payload: null,
      error: asString(payload.error) ?? asString(payload.message) ?? asString(payload.summary) ?? "脚本返回失败结果",
      metadata: {},
    };
  }
  const metadata: Record<string, unknown> = {};
  for (const key of ["message", "summary", "count", "total", "offset", "limit"]) {
    if (payload[key] !== undefined && payload[key] !== null) {
      metadata[key] = payload[key];
    }
  }
  if (isRecord(payload.metadata)) {
    Object.assign(metadata, payload.metadata);
  }
  return { payload: payload.data, error: null, metadata };
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
    llmHint?: string | null;
  },
): ToolExecutionResult {
  return {
    success: true,
    toolName: input.toolName,
    summary: input.summary,
    answer: null,
    outputType: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llmHint: input.llmHint ?? null,
  };
}

function errorResult(
  message: string,
  toolName: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult {
  return {
    success: false,
    toolName,
    summary: message,
    answer: null,
    outputType: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llmHint: null,
  };
}

function resolvePythonExecutable(): string {
  return process.env.RAGSYSTEM_PYTHON ?? process.env.PYTHON ?? "python";
}

function resolveDefaultIsolationMode(): SkillIsolationMode {
  return process.env.RAGSYSTEM_SKILL_ISOLATION === "shared" ? "shared" : "venv";
}

function venvPythonExecutable(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function venvPipExecutable(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "pip.exe")
    : path.join(venvDir, "bin", "pip");
}

/**
 * 在 skill 目录下维护 .venv，并确保 requirements.txt 中的依赖已安装。
 * 返回 venv 内的 Python 解释器路径，失败时返回 error。
 */
async function prepareVenv(
  skillDir: string,
  requirementsFile: string,
): Promise<{ python: string } | { error: string }> {
  const venvDir = path.join(skillDir, ".venv");
  if (!fs.existsSync(venvDir)) {
    const create = await spawnProcess(resolvePythonExecutable(), ["-m", "venv", venvDir], { timeoutMs: 60_000 });
    if (create.returnCode !== 0) {
      return { error: `创建虚拟环境失败: ${create.stderr.trim() || create.stdout.trim()}` };
    }
  }

  const installedMarker = path.join(venvDir, ".installed");
  const requirementsMtime = fs.statSync(requirementsFile).mtimeMs;
  if (fs.existsSync(installedMarker) && fs.statSync(installedMarker).mtimeMs >= requirementsMtime) {
    return { python: venvPythonExecutable(venvDir) };
  }

  const install = await spawnProcess(venvPipExecutable(venvDir), ["install", "-r", requirementsFile], {
    timeoutMs: 300_000,
  });
  if (install.returnCode !== 0) {
    return { error: `安装依赖失败: ${install.stderr.trim() || install.stdout.trim()}` };
  }
  fs.writeFileSync(installedMarker, "");
  return { python: venvPythonExecutable(venvDir) };
}

/**
 * 启动子进程并收集 stdout/stderr，超时后 SIGKILL 并返回 124。
 */
function spawnProcess(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; timeoutMessage?: string },
): Promise<{ stdout: string; stderr: string; returnCode: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: error.message, returnCode: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          stdout: Buffer.concat(chunks).toString("utf8"),
          stderr: options.timeoutMessage ?? "执行超时",
          returnCode: 124,
        });
        return;
      }
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errorChunks).toString("utf8"),
        returnCode: code ?? 0,
      });
    });
  });
}

function resolveWorkspaceRoot(context: ToolExecContext, agent: AgentConfig | null): string | null {
  return normalizeString(context.workspaceRoot) ?? resolveAgentWorkspaceRoot(agent);
}

function resolveAgentWorkspaceRoot(agent: AgentConfig | null): string | null {
  return normalizeString(asRecord(agent?.custom_params)?.workspace_root);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (item) => item.toUpperCase());
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => String(item));
}









function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJsonValue(item);
    }
    return result;
  }
  return null;
}

function toDisplayPath(filePath: string, dataRoot: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(dataRoot);
  if (isPathUnder(resolved, root)) {
    return `./data/${path.relative(root, resolved).replaceAll(path.sep, "/")}`;
  }
  return resolved;
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
