import type { AutoAcceptPattern, PermissionMode, PermissionPolicy, RiskLevel } from "../contracts/permissions.js";

export interface RuntimeToolApprovalInput {
  toolName: string;
  riskLevel?: RiskLevel | null | undefined;
  description?: string | null | undefined;
  arguments?: Record<string, unknown> | undefined;
  sessionId?: string | null | undefined;
  approvalExempt?: boolean | undefined;
  forceAsk?: boolean | undefined;
}

export interface RuntimeToolApprovalDecision {
  action: "allow" | "ask";
  toolName: string;
  riskLevel: RiskLevel;
  description: string;
  permissionMode: PermissionMode;
  reason: string;
  reasonCodes: string[];
  secondaryReasons: string[];
}

export class PermissionPolicyService {
  private policy: PermissionPolicy = {
    mode: "standard",
    auto_accept_patterns: [],
    audit_all_checks: false,
    approval_timeout: 300,
    skip_all_approvals: false,
  };

  getPolicy(): PermissionPolicy {
    return clonePolicy(this.policy);
  }

  setPolicy(policy: PermissionPolicy): PermissionPolicy {
    this.policy = clonePolicy(policy);
    return this.getPolicy();
  }

  setMode(mode: PermissionMode): { mode: PermissionMode } {
    this.policy = {
      ...this.policy,
      mode,
    };
    return { mode: this.policy.mode };
  }

  addAutoAcceptPattern(pattern: AutoAcceptPattern): PermissionPolicy {
    this.policy = {
      ...this.policy,
      auto_accept_patterns: [
        ...this.policy.auto_accept_patterns,
        {
          pattern_type: pattern.pattern_type,
          pattern_value: pattern.pattern_value,
          description: pattern.description ?? "",
        },
      ],
    };
    return this.getPolicy();
  }

  removeAutoAcceptPattern(input: { pattern_type: string; pattern_value: string }): { removed: boolean } & PermissionPolicy {
    const before = this.policy.auto_accept_patterns.length;
    const remaining = this.policy.auto_accept_patterns.filter(
      (pattern) =>
        !(pattern.pattern_type === input.pattern_type && pattern.pattern_value === input.pattern_value),
    );
    this.policy = {
      ...this.policy,
      auto_accept_patterns: remaining,
    };
    return {
      removed: remaining.length < before,
      ...this.getPolicy(),
    };
  }

  clearAutoAcceptPatterns(): PermissionPolicy {
    this.policy = {
      ...this.policy,
      auto_accept_patterns: [],
    };
    return this.getPolicy();
  }

  evaluateToolApproval(input: RuntimeToolApprovalInput): RuntimeToolApprovalDecision {
    const policy = this.getPolicy();
    const toolName = input.toolName.trim();
    const riskLevel = input.riskLevel ?? "low";
    const description = input.description?.trim() || `Tool ${toolName}`;
    const base = {
      toolName,
      riskLevel,
      description,
      permissionMode: policy.mode,
      reasonCodes: [],
      secondaryReasons: [],
    };

    if (input.approvalExempt) {
      return {
        ...base,
        action: "allow",
        reason: "runtime control tool skips approval",
      };
    }
    if (policy.skip_all_approvals) {
      return {
        ...base,
        action: "allow",
        reason: "skip_all_approvals enabled, skipping approval",
      };
    }
    if (policy.mode === "dangerously_skip_permissions") {
      return {
        ...base,
        action: "allow",
        reason: "dangerously_skip_permissions 模式，跳过审批",
      };
    }

    const autoAcceptReason = matchAutoAccept(toolName, riskLevel, input.arguments ?? {}, policy);
    if (autoAcceptReason) {
      return {
        ...base,
        action: "allow",
        reason: autoAcceptReason,
      };
    }

    const askReason = input.forceAsk ? "当前策略要求人工审批" : getModeApprovalReason(policy.mode, riskLevel);
    if (!askReason) {
      return {
        ...base,
        action: "allow",
        reason: "",
      };
    }

    return {
      ...base,
      action: "ask",
      reason: askReason,
      reasonCodes: ["ask-risk"],
    };
  }
}

function clonePolicy(policy: PermissionPolicy): PermissionPolicy {
  return {
    mode: policy.mode,
    auto_accept_patterns: policy.auto_accept_patterns.map((pattern) => ({
      pattern_type: pattern.pattern_type,
      pattern_value: pattern.pattern_value,
      description: pattern.description ?? "",
    })),
    audit_all_checks: policy.audit_all_checks,
    approval_timeout: policy.approval_timeout,
    skip_all_approvals: policy.skip_all_approvals,
  };
}

function getModeApprovalReason(mode: PermissionMode, riskLevel: RiskLevel): string {
  if (mode === "strict") {
    return `严格模式：${riskLevel} 风险工具需要审批`;
  }
  if (mode === "standard") {
    return riskLevel === "medium" || riskLevel === "high"
      ? `标准模式：${riskLevel} 风险工具需要审批`
      : "";
  }
  if (mode === "relaxed") {
    return riskLevel === "high" ? "宽松模式：高风险工具需要审批" : "";
  }
  return "";
}

function matchAutoAccept(
  toolName: string,
  riskLevel: RiskLevel,
  args: Record<string, unknown>,
  policy: PermissionPolicy,
): string {
  for (const pattern of policy.auto_accept_patterns) {
    if (pattern.pattern_type === "tool_name" && matchGlob(toolName, pattern.pattern_value)) {
      return `工具名匹配规则 '${pattern.pattern_value}' 自动接受`;
    }
    if (pattern.pattern_type === "file_pattern") {
      const filePath = asString(args.file_path) ?? asString(args.filePath);
      if (filePath && matchGlob(filePath, pattern.pattern_value)) {
        return `文件路径匹配规则 '${pattern.pattern_value}' 自动接受`;
      }
    }
    if (pattern.pattern_type === "risk_level" && riskLevel === pattern.pattern_value) {
      return `风险等级匹配规则 '${pattern.pattern_value}' 自动接受`;
    }
  }
  return "";
}

function matchGlob(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`;
  return new RegExp(source).test(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
