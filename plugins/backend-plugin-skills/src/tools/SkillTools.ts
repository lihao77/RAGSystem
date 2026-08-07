import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import { z } from "zod";

import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import type { SkillsAgentConfig } from "../config.js";
import type { SkillToolService } from "./SkillExecution.js";
import { readSkillToolArguments } from "./SkillExecution.js";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { RuntimeToolDefinition } from "@ragsystem/agent-sdk";
import { metadataFrom, nullableStringArray, optionalBoolean, optionalString } from "@ragsystem/backend-core/tools/schema-helpers.js";

const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";
const LOAD_SKILL_RESOURCE_TOOL_NAME = "load_skill_resource";
const EXECUTE_SKILL_SCRIPT_TOOL_NAME = "execute_skill_script";

interface SkillToolDeps {
  skillTools: SkillToolService | null;
  agent: AgentConfig | null;
  config: SkillsAgentConfig;
  pathService: PathAccessPolicy;
}

const skillBaseSchema = z.object({
  skill_name: z.string(),
  skillName: z.string().optional(),
  workspace_root: optionalString,
  workspaceRoot: optionalString,
});

const activateSkillSchema = skillBaseSchema.strict();
const loadSkillResourceSchema = skillBaseSchema.extend({
  resource_file: z.string(),
  resourceFile: z.string().optional(),
}).strict();
const executeSkillScriptSchema = skillBaseSchema.extend({
  script_name: z.string(),
  scriptName: z.string().optional(),
  arguments: nullableStringArray(),
  cwd: optionalString,
  run_in_background: optionalBoolean,
  runInBackground: optionalBoolean,
}).strict();

const SKILL_TOOLS: RuntimeToolDefinition[] = [
  {
    name: ACTIVATE_SKILL_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowed_callers: ["direct"],
    observationPolicy: "inline",
    description: "Activate a Skill and return its SKILL.md main instructions.",
    returns: {
      description: "成功时返回 Skill 主文件内容和基础信息。",
      shape: {
        skill_name: "string",
        description: "string",
        main_content: "string",
      },
    },
    usage_contract: [
      "activate_skill 通常是使用 Skill 的第一步。",
      "返回的 main_content 就是 SKILL.md 正文，可直接按其中流程继续执行。",
      "若主文件提到额外资源，再调用 load_skill_resource。",
      "若主文件要求执行脚本，再调用 execute_skill_script。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: LOAD_SKILL_RESOURCE_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowed_callers: ["direct"],
    observationPolicy: "inline",
    description: "Load an additional resource file from an activated Skill.",
    returns: {
      description: "成功时返回指定资源文件的内容。",
      shape: {
        file_name: "string",
        content: "string",
        skill: "string",
      },
    },
    usage_contract: [
      "load_skill_resource 用于加载 activate_skill 主文件里提到的补充文档。",
      "resource_file 应使用主文件中出现的相对文件名。",
      "加载后的 content 可直接作为后续执行依据。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "resource_file"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        resource_file: { type: "string", description: "Relative resource file name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: EXECUTE_SKILL_SCRIPT_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "medium",
    allowed_callers: ["direct"],
    description:
      "Execute a Skill utility script in an Agent-selected working directory. Relative cwd values resolve from the current workspace; external directories require path approval.",
    usage_contract: [
      "arguments 是 argv token 数组，每个 token 一个数组项，不要合并成单个字符串或 JSON 对象。",
      "用 cwd 决定脚本执行和输出目录；相对 cwd 从 workspace 解析，未传时使用 workspace 根目录。",
      "workspace 外的 cwd 会进入路径审批，批准后脚本才会执行。",
      "脚本可通过 SESSION_WORKSPACE_DIR、SESSION_UPLOADS_DIR 访问受管路径；返回 cwd 下的相对路径供后续工具使用。",
      "transient 或 workspace 外的脚本输出不能直接作为最终 file_ref；需要交付时先写入 workspace，再引用真实 workspace 相对路径。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "script_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        script_name: { type: "string", description: "Script file name under the Skill scripts directory." },
        arguments: {
          type: "array",
          items: { type: "string" },
          description:
            "Command line argv tokens, one token per array item (e.g. [\"--data\", \"data.json\"]). Do not join tokens with spaces/semicolons, and do not pass an object like {\"--data\":\"...\"}.",
        },
        cwd: {
          type: "string",
          description: "Working directory for the script. Relative paths resolve from workspace; absolute external paths require approval.",
        },
        run_in_background: { type: "boolean", description: "Reserved for background execution." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
];

export function createSkillTools(deps: SkillToolDeps): Tool[] {
  const skillTools = deps.skillTools;
  const agent = deps.agent;
  const workspaceRoot = agentWorkspaceRoot(agent);
  // run_in_background 仅在 agent 启用 tasks.background 时暴露（与 SkillExecution 守卫同源）。
  const allowBackground = !!agent?.tasks?.background;
  const visibleSkills = skillTools ? skillTools.listVisibleSkills(agent, deps.config, workspaceRoot) : [];
  if (!skillTools || !visibleSkills.length) {
    return [];
  }
  // 候选 Skill 名称与用途直接进入 function schema，避免在 system prompt 重复整份清单。
  const skillNames = visibleSkills.map((skill) => skill.name);
  const withSkillList = (definition: RuntimeToolDefinition): RuntimeToolDefinition => ({
    ...definition,
    parameters: injectSkillNameEnum(definition.parameters, skillNames, visibleSkills),
  });
  const definitionByName = new Map(SKILL_TOOLS.map((definition) => [definition.name, definition]));
  return [
    buildTool({
      ...metadataFrom(withSkillList(definitionByName.get(ACTIVATE_SKILL_TOOL_NAME)!)),
      inputSchema: activateSkillSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.activateSkill(readSkillToolArguments(input), context, agent, deps.config),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(LOAD_SKILL_RESOURCE_TOOL_NAME)!),
      inputSchema: loadSkillResourceSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.loadSkillResource(readSkillToolArguments(input), context, agent, deps.config),
    }),
    buildTool({
      ...metadataFrom(omitBackgroundParam(definitionByName.get(EXECUTE_SKILL_SCRIPT_TOOL_NAME)!, allowBackground)),
      inputSchema: executeSkillScriptSchema,
      isConcurrencySafe: () => false,
      checkAccess: (input: Record<string, unknown>, context: ToolExecContext) => {
        const parsed = readSkillToolArguments(input);
        const candidates = skillTools.getExternalCwdCandidates(parsed.cwd, context, agent, deps.pathService);
        return candidates.length
          ? { action: "allow" as const, signals: { candidatePaths: candidates } }
          : { action: "allow" as const };
      },
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.executeSkillScript(
        readSkillToolArguments(input),
        context,
        agent,
        deps.config,
        deps.pathService,
      ),
    }),
  ];
}

/** 给 skill_name 参数补 enum 和候选用途，让 function schema 自包含。 */
function injectSkillNameEnum(
  parameters: Record<string, unknown>,
  skillNames: string[],
  skills: { name: string; description: string; requires?: { mcp_servers?: string[] } }[],
): Record<string, unknown> {
  const properties = isRecord(parameters.properties) ? { ...parameters.properties } : {};
  const rawSkillName = isRecord(properties.skill_name) ? properties.skill_name : {};
  const baseDescription = typeof rawSkillName.description === "string" ? rawSkillName.description : "Skill name.";
  const candidates = skills.map(formatSkillCandidate).join("; ");
  properties.skill_name = {
    ...rawSkillName,
    enum: skillNames,
    description: candidates ? `${baseDescription} Allowed candidates: ${candidates}` : baseDescription,
  };
  return { ...parameters, properties };
}

/** 未启用后台任务时，从工具 parameters 裁掉 run_in_background（可见性与 SkillExecution 守卫同源）。 */
function omitBackgroundParam(definition: RuntimeToolDefinition, allowBackground: boolean): RuntimeToolDefinition {
  if (allowBackground) {
    return definition;
  }
  const parameters = definition.parameters;
  const properties = isRecord(parameters.properties) ? { ...parameters.properties } : {};
  if (!("run_in_background" in properties)) {
    return definition;
  }
  delete properties.run_in_background;
  return { ...definition, parameters: { ...parameters, properties } };
}

function formatSkillCandidate(skill: { name: string; description: string; requires?: { mcp_servers?: string[] } }): string {
  const requirements = skill.requires?.mcp_servers?.length
    ? `; requires MCP: ${skill.requires.mcp_servers.join(", ")}`
    : "";
  return skill.description ? `${skill.name}: ${skill.description}${requirements}` : `${skill.name}${requirements}`;
}

function agentWorkspaceRoot(agent: AgentConfig | null): string | null {
  const params = agent?.custom_params;
  return isRecord(params) && typeof params.workspace_root === "string" && params.workspace_root.trim()
    ? params.workspace_root.trim()
    : null;
}
