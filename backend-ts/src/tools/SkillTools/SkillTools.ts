import { z } from "zod";

import type { AgentConfig } from "../../contracts/agent-config.js";
import type { SkillToolService } from "./SkillExecution.js";
import { readSkillToolArguments } from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  EXECUTE_SKILL_SCRIPT_TOOL_NAME,
  GET_SKILL_INFO_TOOL_NAME,
  LOAD_SKILL_RESOURCE_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { RuntimeToolDefinition } from "@ragsystem/agent-sdk";
import { metadataFrom, nullableStringArray, optionalBoolean, optionalString } from "../schema-helpers.js";

interface SkillToolDeps {
  skillTools: SkillToolService | null;
  agent: AgentConfig | null;
}

const skillBaseSchema = z.object({
  skill_name: z.string(),
  skillName: z.string().optional(),
  workspace_root: optionalString,
  workspaceRoot: optionalString,
});

const activateSkillSchema = skillBaseSchema.strict();
const getSkillInfoSchema = skillBaseSchema.strict();
const loadSkillResourceSchema = skillBaseSchema.extend({
  resource_file: z.string(),
  resourceFile: z.string().optional(),
}).strict();
const executeSkillScriptSchema = skillBaseSchema.extend({
  script_name: z.string(),
  scriptName: z.string().optional(),
  arguments: nullableStringArray(),
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
      "Execute a Skill utility script. The arguments field is argv-style: each command-line token must be one array item.",
    usage_contract: [
      "arguments 是 argv token 数组，不要合并成单个字符串。",
      "XML 调用时 arguments 必须用 <item> 表示每个 token。",
      "不要使用 <arg>，不要把多个参数合并成一个字符串或 JSON 对象。",
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
            "Command line argv tokens. XML calls must use <item> children, one token per item, such as <item>--data</item><item>data.json</item>. Do not use <arg>, do not join tokens with spaces/semicolons, and do not pass an object like {\"--data\":\"...\"}.",
        },
        run_in_background: { type: "boolean", description: "Reserved for background execution." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: GET_SKILL_INFO_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Get lightweight Skill metadata without loading full instructions.",
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
];

export function createSkillTools(deps: SkillToolDeps): Tool[] {
  const skillTools = deps.skillTools;
  const agent = deps.agent;
  if (!skillTools || !skillTools.hasVisibleSkills(agent, agentWorkspaceRoot(agent))) {
    return [];
  }
  const definitionByName = new Map(SKILL_TOOLS.map((definition) => [definition.name, definition]));
  return [
    buildTool({
      ...metadataFrom(definitionByName.get(ACTIVATE_SKILL_TOOL_NAME)!),
      inputSchema: activateSkillSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.activateSkill(readSkillToolArguments(input), context, agent),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(LOAD_SKILL_RESOURCE_TOOL_NAME)!),
      inputSchema: loadSkillResourceSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.loadSkillResource(readSkillToolArguments(input), context, agent),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(EXECUTE_SKILL_SCRIPT_TOOL_NAME)!),
      inputSchema: executeSkillScriptSchema,
      isConcurrencySafe: () => false,
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.executeSkillScript(readSkillToolArguments(input), context, agent),
    }),
    buildTool({
      ...metadataFrom(definitionByName.get(GET_SKILL_INFO_TOOL_NAME)!),
      inputSchema: getSkillInfoSchema,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: (input: Record<string, unknown>, context: ToolExecContext) => skillTools.getSkillInfo(readSkillToolArguments(input), context, agent),
    }),
  ];
}

function agentWorkspaceRoot(agent: AgentConfig | null): string | null {
  const params = agent?.custom_params;
  return isRecord(params) && typeof params.workspace_root === "string" && params.workspace_root.trim()
    ? params.workspace_root.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
