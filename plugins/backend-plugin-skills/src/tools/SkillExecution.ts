import { normalizeString, asRecord } from "@ragsystem/backend-core/utils/guards.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { SkillsAgentConfig, SkillsAgentConfigService } from "../config.js";
import type { ISkillPackageStore, SkillPackageRecord } from "../contracts/skills/skill-package-store.js";
import { parseSkillMarkdown } from "../contracts/skills/skill-markdown.js";
import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";

type SkillSourceType = "workspace" | "user_global" | "builtin";

interface SkillSourceSpec {
  root: string;
  sourceType: SkillSourceType;
  sourceLabel: string;
  isAutoInjectCandidate: boolean;
}

export interface BuiltinSkillSourceInput {
  root: string;
  sourceLabel: string;
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
  requires?: SkillRequires;
}

export interface SkillToolInput {
  skillName: string;
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
  private readonly builtinSkillsRoot: string;
  private readonly additionalBuiltinSkillSources: readonly BuiltinSkillSourceInput[];
  private readonly userGlobalSkillsRoot: string;

  constructor(
    options: {
      dataRoot?: string | undefined;
      builtinSkillsRoot?: string | undefined;
      additionalBuiltinSkillSources?: readonly BuiltinSkillSourceInput[] | undefined;
      userGlobalSkillsRoot?: string | undefined;
      skillsConfig?: SkillsAgentConfigService | null | undefined;
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
    const dataRoot = path.resolve(options.dataRoot);
    this.builtinSkillsRoot = path.resolve(options.builtinSkillsRoot ?? resolveDefaultBuiltinSkillsRoot());
    this.additionalBuiltinSkillSources = dedupeBuiltinSkillSources(options.additionalBuiltinSkillSources ?? []);
    this.userGlobalSkillsRoot = path.resolve(options.userGlobalSkillsRoot ?? path.join(dataRoot, "skills"));
    this.skillsConfig = options.skillsConfig ?? null;
    this.packageStore = options.packageStore ?? null;
  }

  private readonly skillsConfig: SkillsAgentConfigService | null;
  private readonly packageStore: ISkillPackageStore | null;
  private hydrateChain: Promise<void> = Promise.resolve();
  private userGlobalPackageCache: SkillPackageRecord[] = [];

  /** Refresh only descriptions/instructions, without loading resources or preparing execution. */
  async hydrateUserGlobalMetadata(): Promise<void> {
    if (!this.packageStore) return;
    const run = async (): Promise<void> => {
      this.userGlobalPackageCache = this.packageStore!.listMetadata
        ? (await this.packageStore!.listMetadata()).map((record) => ({
            ...record, skillDir: path.join(this.userGlobalSkillsRoot, record.name),
          }))
        : await this.packageStore!.list();
    };
    this.hydrateChain = this.hydrateChain.then(run, run);
    await this.hydrateChain;
  }

  /** builtin skill 根目录（代码库内置，只读）。 */
  getBuiltinSkillsRoot(): string {
    return this.builtinSkillsRoot;
  }

  /** 用户全局 skill 根目录（dataRoot/skills）。 */
  getUserGlobalSkillsRoot(): string {
    return this.userGlobalSkillsRoot;
  }

  /** workspace skill 根：<workspaceRoot>/.ragsystem/skills；无 workspaceRoot 返回 null。 */
  resolveWorkspaceSkillsRoot(workspaceRoot?: string | null): string | null {
    const workspace = normalizeString(workspaceRoot);
    return workspace ? path.join(path.resolve(workspace), ".ragsystem", "skills") : null;
  }

  listAvailableSkills(workspaceRoot?: string | null): SkillListItem[] {
    return this.toListItems(this.loadAllSkills(workspaceRoot));
  }

  private toListItems(skills: SkillInfo[]): SkillListItem[] {
    return skills.map((skill) => ({
      name: skill.name,
      display_name: titleCase(skill.name.replaceAll("-", " ")),
      description: skill.description,
      source_type: skill.sourceType,
      source_label: skill.sourceLabel,
      is_auto_inject_candidate: skill.isAutoInjectCandidate,
      ...(skill.requires ? { requires: skill.requires } : {}),
    }));
  }

  async listAvailableSkillsAsync(workspaceRoot?: string | null): Promise<SkillListItem[]> {
    await this.hydrateUserGlobalMetadata();
    return this.listAvailableSkills(workspaceRoot);
  }

  /** 删除 Skill 时联动清理插件自有 Agent 配置中的引用。 */
  async purgeSkillReference(skillName: string): Promise<string[]> {
    return this.skillsConfig?.purgeSkillReference(skillName) ?? [];
  }

  hasVisibleSkills(agent: AgentConfig | null, config: SkillsAgentConfig, workspaceRoot?: string | null): boolean {
    return this.listVisibleSkills(agent, config, workspaceRoot).length > 0;
  }

  /**
   * 当前 Agent 可见的 Skill 列表（含 name/description），供 skill 工具自描述其参数 enum 与
   * extended_usage 清单——可见性规则与 activate_skill 运行时校验完全一致。
   */
  listVisibleSkills(agent: AgentConfig | null, config: SkillsAgentConfig, workspaceRoot?: string | null): SkillInfo[] {
    return this.resolveVisibleSkills(agent, config, workspaceRoot ?? resolveAgentWorkspaceRoot(agent));
  }

  async listVisibleSkillsAsync(agent: AgentConfig | null, config: SkillsAgentConfig, workspaceRoot?: string | null): Promise<SkillInfo[]> {
    await this.hydrateUserGlobalMetadata();
    return this.listVisibleSkills(agent, config, workspaceRoot);
  }

  async activateSkill(
    input: SkillToolInput,
    context: ToolExecContext,
    agent: AgentConfig | null,
    config: SkillsAgentConfig,
    pathService?: PathAccessPolicy,
  ): Promise<ToolExecutionResult> {
    const toolName = "activate_skill";
    await this.hydrateUserGlobalMetadata();
    const visible = this.listVisibleSkills(agent, config, resolveWorkspaceRoot(context, agent));
    let skill = visible.find((item) => item.name === input.skillName.trim());
    if (!skill) return toolError(toolName, `Skill '${input.skillName}' 不存在或当前 Agent 无权使用。可用的 Skills: ${visible.map((item) => item.name).join(", ")}`);
    if (skill.sourceType === "user_global" && this.packageStore) {
      const record = await this.packageStore.get(skill.name);
      if (!record) return toolError(toolName, `Skill '${skill.name}' 不存在`);
      skill = skillInfoFromPackageRecord(record, this.userGlobalSkillsRoot);
    }
    const skillRoot = fs.realpathSync(skill.skillDir);
    pathService?.approveRead?.([skillRoot]);
    return toolSuccess({
      skill_name: skill.name,
      description: skill.description,
      skill_root: skillRoot,
      main_content: skill.content,
    }, {
      toolName,
      summary: `已加载 Skill '${skill.name}'`,
      outputType: "json",
      metadata: { source_type: skill.sourceType, source_label: skill.sourceLabel },
    });
  }

  loadAllSkills(workspaceRoot?: string | null): SkillInfo[] {
    return this.mergeSkillSources(this.loadUserGlobalSkills(), workspaceRoot);
  }

  private mergeSkillSources(userGlobalSkills: SkillInfo[], workspaceRoot?: string | null): SkillInfo[] {
    const deduped = new Map<string, SkillInfo>();
    for (const skill of userGlobalSkills) {
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
      return this.userGlobalPackageCache
        .map((record) => skillInfoFromPackageRecord(record, this.userGlobalSkillsRoot));
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

  private resolveVisibleSkills(agent: AgentConfig | null, config: SkillsAgentConfig, workspaceRoot?: string | null): SkillInfo[] {
    const skills = this.loadAllSkills(workspaceRoot);
    const enabled = new Set(config.enabled_skills);
    const isEntry = agent?.default_entry === true;
    return skills.filter((skill) => {
      if (enabled.has(skill.name)) {
        return true;
      }
      return isEntry && skill.sourceType === "workspace";
    });
  }

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
    for (const source of this.additionalBuiltinSkillSources) {
      specs.push({
        root: source.root,
        sourceType: "builtin",
        sourceLabel: source.sourceLabel,
        isAutoInjectCandidate: true,
      });
    }
    return specs;
  }
}

function dedupeBuiltinSkillSources(sources: readonly BuiltinSkillSourceInput[]): readonly BuiltinSkillSourceInput[] {
  const byRoot = new Map<string, BuiltinSkillSourceInput>();
  for (const source of sources) {
    const root = path.resolve(source.root);
    if (!byRoot.has(root)) byRoot.set(root, { root, sourceLabel: source.sourceLabel });
  }
  return [...byRoot.values()];
}

function resolveDefaultBuiltinSkillsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../skills"),
    path.resolve(moduleDir, "plugin-assets/skills"),
  ];
  const root = candidates.find((candidate) => fs.existsSync(candidate));
  if (!root) {
    throw new Error(`Packaged Skills assets are missing; checked: ${candidates.join(", ")}`);
  }
  return root;
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

function parseSkill(skillDir: string, spec: SkillSourceSpec): SkillInfo | null {
  try {
    const parsed = parseSkillMarkdown(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
    if (!parsed?.name || !parsed.description) return null;
    return {
      ...parsed, skillDir, sourceType: spec.sourceType, sourceLabel: spec.sourceLabel,
      isAutoInjectCandidate: spec.isAutoInjectCandidate, originRoot: spec.root,
    };
  } catch { return null; }
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

function resolveWorkspaceRoot(context: ToolExecContext, agent: AgentConfig | null): string | null {
  return context.executionPaths?.workspace ?? normalizeString(context.workspaceRoot) ?? resolveAgentWorkspaceRoot(agent);
}

function resolveAgentWorkspaceRoot(agent: AgentConfig | null): string | null {
  return normalizeString(asRecord(agent?.custom_params)?.workspace_root);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (item) => item.toUpperCase());
}
