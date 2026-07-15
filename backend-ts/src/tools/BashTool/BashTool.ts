import { z } from "zod";

import type { LocalBashToolService } from "./BashExecution.js";
import { readBashArguments } from "../../services/runtime/runtime-tool-bridge/arguments.js";
import { EXECUTE_BASH_TOOL_NAME } from "../../services/runtime/runtime-tool-bridge/registry.js";
import { buildTool, type Tool, type ToolExecContext, type ToolAccessDecision } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent-config.js";
import type { PathApprovalService } from "../../services/runtime/path-service.js";
import { optionalBoolean, optionalInteger, optionalString } from "../schema-helpers.js";

interface BashToolDeps {
  bashTools: LocalBashToolService | null;
  agent: AgentConfig;
  pathService: PathApprovalService;
}

const bashSchema = z.object({
  command: z.string(),
  working_dir: optionalString,
  workingDir: optionalString,
  working_dir_space: optionalString,
  workingDirSpace: optionalString,
  timeout: optionalInteger,
  run_in_background: optionalBoolean,
  runInBackground: optionalBoolean,
  description: optionalString,
}).strict();

export function createBashTools(deps: BashToolDeps): Tool[] {
  const bashTools = deps.bashTools;
  if (!bashTools) {
    return [];
  }
  const enabled = new Set(deps.agent.tools.enabled_tools ?? []);
  if (!enabled.has(EXECUTE_BASH_TOOL_NAME)) {
    return [];
  }
  // run_in_background 仅在 agent 启用 tasks.background 时暴露给模型（与 BashExecution 守卫同源）。
  const allowBackground = !!deps.agent.tasks?.background;
  return [
    buildTool({
      name: EXECUTE_BASH_TOOL_NAME,
      description:
        "Execute a shell command in a managed workspace directory. Read-only commands run directly; write, unknown, network, destructive, and interpreter commands may require approval.",
      source: "execution",
      category: "execution",
      riskLevel: "high",
      allowedCallers: ["direct"],
      extendedUsage: `### 适用场景

仅在确实需要 shell/系统命令、且没有专用工具（read_file/edit_file/write_file/glob/grep 等）适用时使用 execute_bash；文件读写与搜索请优先用专用工具。

### 工作目录说明

三个受管目录空间：\`workspace\`（默认）、\`transient\`（临时）、\`exports\`（导出）。

- 相对路径：默认按 \`workspace\` 解析
- 绝对路径：必须在受管目录内
- 指定空间：使用 \`working_dir_space\` 参数`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute. Command substitution, hidden newlines, dangerous env overrides, and write redirection are blocked.",
          },
          working_dir: {
            type: "string",
            description: "Optional working directory. Relative paths resolve against the selected managed space, defaulting to workspace.",
          },
          working_dir_space: {
            type: "string",
            enum: ["workspace", "transient", "exports"],
            description: "Managed directory space for working_dir.",
          },
          timeout: {
            type: "integer",
            minimum: 1,
            maximum: 600,
            description: "Timeout in seconds. Defaults to 120 and is capped at 600.",
          },
          ...(allowBackground
            ? {
                run_in_background: {
                  type: "boolean",
                  description: "Run the command in the background and immediately return a background_task_id.",
                },
              }
            : {}),
          description: {
            type: "string",
            description: "Short purpose shown in approval prompts and execution logs.",
          },
        },
      },
      inputSchema: bashSchema,
      isConcurrencySafe: () => false,
      checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision => {
        const bashInput = readBashArguments(input);
        // 只做命令分类（不 resolve workingDir）：workingDir 越界时 pathService 尚未 approve，resolve 会抛错。
        // 路径越界候选单独计算并交给 permission mode；命令自身高危才声明 ask。
        // call 阶段（gate allow/审批后已 approve）才调完整 prepareExecution resolve。
        const classified = bashTools.buildCommandClassification(bashInput, deps.agent);
        if (!classified.ok) {
          return {
            action: "deny",
            reason: classified.result.summary,
            result: classified.result,
          };
        }
        const c = classified.classification;
        const pathCandidates = bashTools.getExternalCandidates(bashInput, ctx, deps.pathService);
        if (c.approvalRequired) {
          return {
            action: "ask",
            reason: "当前策略要求人工审批",
            riskLevel: c.riskLevel,
            description: c.approvalDescription,
            ...(pathCandidates.length ? { signals: { candidatePaths: pathCandidates } } : {}),
          };
        }
        if (pathCandidates.length) {
          return {
            action: "allow",
            riskLevel: c.riskLevel,
            signals: { candidatePaths: pathCandidates },
          };
        }
        return {
          action: "allow",
          riskLevel: c.riskLevel,
        };
      },
      call: (input, ctx: ToolExecContext) => {
        // workingDir 越界场景：gate 已审批 → pathService.approve(candidate) → 此处 resolve 放行。
        const prepared = bashTools.prepareExecution(readBashArguments(input), ctx, deps.agent, deps.pathService);
        if (!prepared.ok) {
          return prepared.result;
        }
        return bashTools.executePlan(prepared.plan, ctx);
      },
    }),
  ];
}

export { EXECUTE_BASH_TOOL_NAME };
