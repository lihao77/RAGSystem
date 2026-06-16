import { z } from "zod";

import type { BashExecutionPlan, LocalBashToolService } from "../../../tools/local-bash-tool-service.js";
import { errorResult, readBashArguments, withApprovedExternalPaths } from "../../runtime-tool-bridge/arguments.js";
import { EXECUTE_BASH_TOOL_NAME } from "../../runtime-tool-bridge/registry.js";
import { buildTool, type RuntimeTool } from "../tool.js";
import { optionalBoolean, optionalInteger, optionalString } from "./schema-helpers.js";

interface BashToolDeps {
  bashTools: LocalBashToolService | null;
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

export function createBashTools(deps: BashToolDeps): RuntimeTool[] {
  const bashTools = deps.bashTools;
  if (!bashTools) {
    return [];
  }
  return [
    buildTool({
      name: EXECUTE_BASH_TOOL_NAME,
      description:
        "Execute a shell command in a managed workspace directory. Read-only commands run directly; write, unknown, network, destructive, and interpreter commands may require approval.",
      source: "execution",
      category: "execution",
      riskLevel: "high",
      allowedCallers: ["direct"],
      extendedUsage: `### 工作目录说明

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
          run_in_background: {
            type: "boolean",
            description: "Run the command in the background and immediately return a background_task_id.",
          },
          description: {
            type: "string",
            description: "Short purpose shown in approval prompts and execution logs.",
          },
        },
      },
      inputSchema: bashSchema,
      isConcurrencySafe: () => false,
      getExternalPathApprovalCandidates: (input, context) =>
        bashTools.getExternalPathApprovalCandidates(readBashArguments(input), context),
      checkPermissions: (input, context) => {
        const bashInput = readBashArguments(input);
        const approvedExternalPaths = bashTools.getExternalPathApprovalCandidates(bashInput, context);
        const prepared = bashTools.prepareExecution(bashInput, withApprovedExternalPaths(context, approvedExternalPaths));
        if (!prepared.ok) {
          return {
            behavior: "deny",
            reason: prepared.result.summary,
            result: prepared.result,
            metadata: materializePlanError(prepared.result),
          };
        }
        const plan = prepared.plan;
        return {
          behavior: plan.approvalRequired ? "ask" : "allow",
          reason: plan.approvalRequired ? "当前策略要求人工审批" : "命令分类允许直接执行",
          riskLevel: plan.riskLevel,
          description: plan.approvalDescription,
          arguments: plan.approvalArguments,
          approvalType: "bash_command",
          approvedExternalPaths,
          metadata: { bash_plan: plan },
        };
      },
      call: (input, context) => {
        const plan = readCachedPlan(input);
        if (plan) {
          return bashTools.executePlan(plan, context);
        }
        const prepared = bashTools.prepareExecution(readBashArguments(input), context);
        if (!prepared.ok) {
          return prepared.result;
        }
        return bashTools.executePlan(prepared.plan, context);
      },
    }),
  ];
}

function readCachedPlan(input: Record<string, unknown>): BashExecutionPlan | null {
  const value = input.__runtime_bash_plan;
  return isRecord(value) ? value as unknown as BashExecutionPlan : null;
}

function materializePlanError(result: { summary: string; metadata: Record<string, unknown>; content: unknown }): Record<string, unknown> {
  return {
    ...result.metadata,
    content: result.content,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { EXECUTE_BASH_TOOL_NAME };
