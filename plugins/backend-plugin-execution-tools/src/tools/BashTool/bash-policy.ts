import {
  buildApprovalDescription,
  categoryRisk,
  classifyCommand,
  COMMAND_SUBSTITUTION_MARKER,
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
  cwd?: string | null;
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
  cwd: string | null;
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
  /** 目标 shell 是否支持多行命令（bash -c 支持；cmd.exe 经 /c 只执行首行，其余静默丢弃）。 */
  multilineSupported?: boolean;
  /**
   * 目标 shell 是否为 windows(cmd) 语法。cmd 下反斜杠不是转义、单引号不是引号，
   * `\&` 与单引号内的 `&` 仍是命令分隔符，需按 cmd 语义拆段（POSIX 维持字面量）。
   */
  windowsShell?: boolean;
}

export function classifyBashCommand(
  input: BashExecutionInput,
  agent: AgentConfig | null,
  options: BashPolicyOptions,
): BashClassificationResult {
  const command = normalizeString(input.command);
  if (!command) {
    return { ok: false, result: toolError("execute_shell", "execute_shell 缺少 command", { command: "" }) };
  }
  if (options.multilineSupported === false && /[\r\n]/.test(command)) {
    // cmd.exe 经 /c 收到含换行的命令串时只执行首行、其余静默忽略且返回码 0——
    // 模型会误以为整段执行成功，必须显式报错让它改成 `&` 串联的单行形式。
    return {
      ok: false,
      result: toolError(
        "execute_shell",
        "cmd.exe 不支持多行命令（换行后的内容会被忽略且不报错）：请将多条命令用 & 串联在同一行后重试",
        { command },
      ),
    };
  }
  if (input.runInBackground && !options.backgroundSupported) {
    return {
      ok: false,
      result: toolError(
        "execute_shell",
        options.backgroundUnsupportedMessage ?? "当前执行环境不支持后台 shell 命令",
        { command, background_started: false },
      ),
    };
  }
  if (input.runInBackground && !agent?.tasks?.background) {
    return {
      ok: false,
      result: toolError("execute_shell", "当前 Agent 未启用 tasks.background，不能使用 run_in_background 后台执行", {
        command,
        background_started: false,
      }),
    };
  }

  const validation = validateCommand(command, { windowsAmpersand: options.windowsShell === true });
  if (validation.status === "blocked") {
    return {
      ok: false,
      result: toolError("execute_shell", `命令安全检查失败: ${validation.error}`, {
        command,
        classification: "unknown",
      }),
    };
  }
  const description = normalizeString(input.description) ?? "";
  // 命令替换标记不在命令词表里，须单独认定为高风险（派生子 shell）。
  const dangerousCommands = validation.approvalCommands.filter((commandName) =>
    commandName === COMMAND_SUBSTITUTION_MARKER ||
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
      cwd: input.cwd ?? null,
    },
  };
}

export function buildBashExecutionPlan(
  classification: BashCommandClassification,
  resolvedCwd: string,
  displayCwd = resolvedCwd,
): BashExecutionPlan {
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
      cwd: displayCwd,
      resolved_cwd: displayCwd,
      description: classification.description,
      classification: classification.category,
      command_segments: classification.approvalCommands,
      dangerous_command_segments: classification.dangerousCommands,
    },
    metadata: {
      command: classification.command,
      cwd: displayCwd,
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
