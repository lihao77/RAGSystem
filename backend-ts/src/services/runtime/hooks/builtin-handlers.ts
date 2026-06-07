import type { HookHandler, HookResult } from "./types.js";

export const BUILTIN_HOOK_HANDLERS: Record<string, HookHandler> = {
  "hooks.builtin.tool_hooks:handle_risk_audit": ({ context }) => ({
    ...emptyHookResult(),
    tags: ["audited"],
    metadata: {
      audit_logged: true,
      tool_name: context.toolName,
      agent_name: context.agentName,
      result_success: context.resultSnapshot.success ?? null,
    },
  }),
  "hooks.builtin.tool_hooks:handle_high_risk_approval_enhancement": ({ context }) => ({
    ...emptyHookResult(),
    uiMessage: buildHighRiskApprovalMessage(context.toolName ?? "unknown", context.agentDisplayName ?? context.agentName),
    uiMetadata: {
      risk_level: "high",
      requires_review: true,
      tool_category: getToolCategory(context.toolName ?? "unknown"),
    },
    tags: ["approval_enhanced"],
  }),
  "hooks.builtin.tool_hooks:handle_bash_command_validation": ({ context }) => {
    const command = typeof context.inputSnapshot.command === "string" ? context.inputSnapshot.command : "";
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (command.includes(pattern)) {
        return {
          ...emptyHookResult(),
          continueExecution: false,
          blockExecution: true,
          blockReason: `Dangerous command pattern detected: ${pattern}`,
          uiMessage: `Command blocked: contains dangerous pattern '${pattern}'`,
          tags: ["blocked", "dangerous_command"],
        };
      }
    }
    if (context.workspaceTrust === "untrusted") {
      return {
        ...emptyHookResult(),
        permissionDecision: "ask",
        uiMessage: "Bash command in untrusted workspace requires approval",
        tags: ["untrusted_workspace"],
      };
    }
    return emptyHookResult();
  },
  "hooks.builtin.tool_hooks:handle_memory_write_guard": ({ context }) => {
    const scope = asString(context.inputSnapshot.scope) ?? "unknown";
    const memoryType = asString(context.inputSnapshot.memory_type) ?? asString(context.inputSnapshot.memoryType) ?? "unknown";
    const name = asString(context.inputSnapshot.name) ?? "unknown";
    const sessionId = asString(context.inputSnapshot.session_id) ?? asString(context.inputSnapshot.sessionId);
    const additionalContext = [
      `Writing to memory: scope=${scope}, type=${memoryType}, name=${name}`,
      "This will persist across conversations.",
    ];
    if (scope === "session" && sessionId) {
      additionalContext.push(`Bound to session_id=${sessionId}`);
    }
    return {
      ...emptyHookResult(),
      additionalContext,
      tags: ["memory_write"],
    };
  },
};

const DANGEROUS_BASH_PATTERNS = [
  "rm -rf /",
  "dd if=/dev/zero",
  ":(){ :|:& };:",
  "mkfs.",
  "format ",
];

export function emptyHookResult(): HookResult {
  return {
    continueExecution: true,
    blockExecution: false,
    blockReason: "",
  };
}

function buildHighRiskApprovalMessage(toolName: string, agentName: string | null): string {
  const lines = [`High-risk operation: ${toolName}`, ""];
  if (toolName === "execute_bash") {
    lines.push("This command will execute in the system shell. Review file, network, and process side effects.");
  } else if (toolName === "write_file" || toolName === "edit_file") {
    lines.push("This operation will modify files on disk.");
  } else if (toolName === "write_memory") {
    lines.push("This will persist information to memory. Review sensitive content first.");
  }
  if (agentName) {
    lines.push("", `Requested by agent: ${agentName}`);
  }
  return lines.join("\n");
}

function getToolCategory(toolName: string): string {
  if (toolName === "execute_bash") {
    return "system";
  }
  if (toolName === "write_file" || toolName === "edit_file" || toolName === "read_file") {
    return "filesystem";
  }
  if (toolName === "write_memory" || toolName === "read_memory_entry" || toolName === "archive_memory") {
    return "memory";
  }
  if (toolName === "call_agent" || toolName === "send_message") {
    return "agent";
  }
  return "other";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
