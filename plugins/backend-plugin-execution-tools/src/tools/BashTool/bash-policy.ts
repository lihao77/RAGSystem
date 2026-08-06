import {
  buildApprovalDescription,
  categoryRisk,
  classifyCommand,
  validateCommand,
  type CommandCategory,
  type ToolExecutionResult,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { RiskLevel } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import { toolError } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { normalizeString } from "@ragsystem/backend-core/utils/guards.js";

export interface BashExecutionInput {
  command: string;
  workingDir?: string | null;
  workingDirSpace?: string | null;
  timeout?: number | null;
  runInBackground?: boolean | null;
  description?: string | null;
}

export interface BashCommandClassification {
  command: string;
  description: string;
  category: CommandCategory;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  approvalCommands: string[];
  dangerousCommands: string[];
  approvalDescription: string;
  timeoutSeconds: number;
  runInBackground: boolean;
  workingDir: string | null;
  workingDirSpace: string | null;
}

export interface BashExecutionPlan {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  description: string;
  category: CommandCategory;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  approvalCommands: string[];
  dangerousCommands: string[];
  approvalDescription: string;
  approvalArguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  runInBackground: boolean;
}

export type BashClassificationResult =
  | { ok: true; classification: BashCommandClassification }
  | { ok: false; result: ToolExecutionResult };

export type BashExecutionPlanResult =
  | { ok: true; plan: BashExecutionPlan }
  | { ok: false; result: ToolExecutionResult };

export interface BashPolicyOptions {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  backgroundSupported: boolean;
  backgroundUnsupportedMessage?: string;
}

export function classifyBashCommand(
  input: BashExecutionInput,
  agent: AgentConfig | null,
  options: BashPolicyOptions,
): BashClassificationResult {
  const command = normalizeString(input.command);
  if (!command) {
    return { ok: false, result: toolError("execute_bash", "execute_bash 缺少 command", { command: "" }) };
  }
  if (input.runInBackground && !options.backgroundSupported) {
    return {
      ok: false,
      result: toolError(
        "execute_bash",
        options.backgroundUnsupportedMessage ?? "当前执行环境不支持后台 Bash",
        { command, background_started: false },
      ),
    };
  }
  if (input.runInBackground && !agent?.tasks?.background) {
    return {
      ok: false,
      result: toolError("execute_bash", "当前 Agent 未启用 tasks.background，不能使用 run_in_background 后台执行", {
        command,
        background_started: false,
      }),
    };
  }

  const validation = validateCommand(command);
  if (validation.status === "blocked") {
    return {
      ok: false,
      result: toolError("execute_bash", `命令安全检查失败: ${validation.error}`, {
        command,
        classification: "unknown",
      }),
    };
  }
  const description = normalizeString(input.description) ?? "";
  const dangerousCommands = validation.approvalCommands.filter((commandName) =>
    ["destructive", "network", "interpreter"].includes(classifyCommand(commandName)),
  );
  return {
    ok: true,
    classification: {
      command,
      description,
      category: validation.category,
      riskLevel: categoryRisk(validation.category),
      approvalRequired: validation.status === "approval_required",
      approvalCommands: validation.approvalCommands,
      dangerousCommands,
      approvalDescription: buildApprovalDescription({ command, description, category: validation.category, dangerousCommands }),
      timeoutSeconds: clampTimeout(input.timeout, options.defaultTimeoutSeconds, options.maxTimeoutSeconds),
      runInBackground: Boolean(input.runInBackground),
      workingDir: input.workingDir ?? null,
      workingDirSpace: input.workingDirSpace ?? null,
    },
  };
}

export function buildBashExecutionPlan(
  classification: BashCommandClassification,
  resolvedCwd: string,
  displayCwd = resolvedCwd,
): BashExecutionPlan {
  const workingDirSpace = classification.workingDirSpace ?? "workspace";
  return {
    command: classification.command,
    cwd: resolvedCwd,
    timeoutSeconds: classification.timeoutSeconds,
    description: classification.description,
    category: classification.category,
    riskLevel: classification.riskLevel,
    approvalRequired: classification.approvalRequired,
    approvalCommands: classification.approvalCommands,
    dangerousCommands: classification.dangerousCommands,
    approvalDescription: classification.approvalDescription,
    approvalArguments: {
      command: classification.command,
      working_dir: displayCwd,
      working_dir_space: workingDirSpace,
      resolved_working_dir: displayCwd,
      description: classification.description,
      classification: classification.category,
      command_segments: classification.approvalCommands,
      dangerous_command_segments: classification.dangerousCommands,
    },
    metadata: {
      command: classification.command,
      working_dir: displayCwd,
      working_dir_space: workingDirSpace,
      classification: classification.category,
      risk_level: classification.riskLevel,
      timeout_seconds: classification.timeoutSeconds,
      ...(classification.approvalCommands.length ? { approval_required_commands: classification.approvalCommands } : {}),
    },
    runInBackground: classification.runInBackground,
  };
}

export function clampTimeout(value: number | null | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, value));
}
