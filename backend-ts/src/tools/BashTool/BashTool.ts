import { z } from "zod";

import type { BashExecutionPlan, LocalBashToolService } from "./BashExecution.js";
import { readBashArguments } from "../../services/runtime/runtime-tool-bridge/arguments.js";
import { EXECUTE_BASH_TOOL_NAME } from "../../services/runtime/runtime-tool-bridge/registry.js";
import { buildTool, type Tool, type ToolExecContext, type ToolAccessDecision } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent-config.js";
import { optionalBoolean, optionalInteger, optionalString } from "../schema-helpers.js";

interface BashToolDeps {
  bashTools: LocalBashToolService | null;
  agent: AgentConfig;
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
      getExternalPathApprovalCandidates: (input, ctx: ToolExecContext) =>
        bashTools.getExternalPathApprovalCandidates(readBashArguments(input), ctx),
      checkAccess: (input, ctx: ToolExecContext): ToolAccessDecision => {
        const bashInput = readBashArguments(input);
        const approvedExternalPaths = bashTools.getExternalPathApprovalCandidates(bashInput, ctx);
        const ctxWithPaths: ToolExecContext = { ...ctx, approvedExternalPaths: mergePaths(ctx.approvedExternalPaths, approvedExternalPaths) };
        const prepared = bashTools.prepareExecution(bashInput, ctxWithPaths, deps.agent);
        if (!prepared.ok) {
          return {
            action: "deny",
            reason: prepared.result.summary,
            result: prepared.result,
            signals: materializePlanError(prepared.result),
          };
        }
        const plan = prepared.plan;
        if (plan.approvalRequired) {
          return {
            action: "ask",
            reason: "当前策略要求人工审批",
            riskLevel: plan.riskLevel,
            description: plan.approvalDescription,
            signals: { bash_plan: plan, approval_arguments: plan.approvalArguments, approval_type: "bash_command", approved_external_paths: approvedExternalPaths },
          };
        }
        return {
          action: "allow",
          riskLevel: plan.riskLevel,
          signals: { bash_plan: plan, approval_arguments: plan.approvalArguments, approval_type: "bash_command", approved_external_paths: approvedExternalPaths },
        };
      },
      call: (input, ctx: ToolExecContext) => {
        const plan = readCachedPlan(input);
        if (plan) {
          return bashTools.executePlan(plan, ctx);
        }
        const prepared = bashTools.prepareExecution(readBashArguments(input), ctx, deps.agent);
        if (!prepared.ok) {
          return prepared.result;
        }
        return bashTools.executePlan(prepared.plan, ctx);
      },
    }),
  ];
}

function mergePaths(existing: string[] | undefined, extra: string[]): string[] {
  const seen = new Set(existing ?? []);
  const merged = [...(existing ?? [])];
  for (const p of extra) {
    if (!seen.has(p)) {
      seen.add(p);
      merged.push(p);
    }
  }
  return merged;
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
