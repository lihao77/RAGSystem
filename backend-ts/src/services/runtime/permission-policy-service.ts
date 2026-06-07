import type { AutoAcceptPattern, PermissionMode, PermissionPolicy, RiskLevel } from "../../contracts/permissions.js";

export interface RuntimeToolApprovalInput {
  toolName: string;
  riskLevel?: RiskLevel | null | undefined;
  description?: string | null | undefined;
  arguments?: Record<string, unknown> | undefined;
  sessionId?: string | null | undefined;
  approvalExempt?: boolean | undefined;
  forceAsk?: boolean | undefined;
  approvedExternalPaths?: string[] | undefined;
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
  approvedExternalPaths: string[];
}

export class PermissionPolicyService {
  private policy: PermissionPolicy = {
    mode: "standard",
    auto_accept_patterns: [],
    audit_all_checks: false,
    approval_timeout: 300,
    skip_all_approvals: false,
  };
  private readonly sessionOverrides = new Map<string, PermissionPolicy>();

  getPolicy(): PermissionPolicy {
    return clonePolicy(this.policy);
  }

  getEffectivePolicy(sessionId?: string | null | undefined): PermissionPolicy {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const override = normalizedSessionId ? this.sessionOverrides.get(normalizedSessionId) : undefined;
    return clonePolicy(override ?? this.policy);
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

  setSessionPermissionOverride(sessionId: string, policy: PermissionPolicy): PermissionPolicy {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      throw new Error("session_id 不能为空");
    }
    this.sessionOverrides.set(normalizedSessionId, clonePolicy(policy));
    return this.getEffectivePolicy(normalizedSessionId);
  }

  clearSessionPermissionOverride(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (normalizedSessionId) {
      this.sessionOverrides.delete(normalizedSessionId);
    }
  }

  evaluateToolApproval(input: RuntimeToolApprovalInput): RuntimeToolApprovalDecision {
    const policy = this.getEffectivePolicy(input.sessionId);
    const toolName = input.toolName.trim();
    const riskLevel = input.riskLevel ?? "low";
    const description = input.description?.trim() || `Tool ${toolName}`;
    const approvedExternalPaths = dedupeStrings(input.approvedExternalPaths ?? []);
    const base = {
      toolName,
      riskLevel,
      description,
      permissionMode: policy.mode,
      reasonCodes: [],
      secondaryReasons: [],
      approvedExternalPaths,
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

    const autoAcceptReason = matchAutoAccept(toolName, riskLevel, input.arguments ?? {}, policy);

    let allowReason = "";
    let riskReason = "";
    let riskRequiresApproval = false;
    if (autoAcceptReason) {
      allowReason = autoAcceptReason;
      riskReason = autoAcceptReason;
    } else if (policy.mode === "dangerously_skip_permissions") {
      allowReason = "dangerously_skip_permissions 模式，跳过审批";
      riskReason = allowReason;
    } else if (input.forceAsk) {
      riskRequiresApproval = true;
      riskReason = "当前策略要求人工审批";
    } else {
      riskReason = getModeApprovalReason(policy.mode, riskLevel);
      riskRequiresApproval = Boolean(riskReason);
    }

    if (approvedExternalPaths.length) {
      const reasonPayload = buildApprovalReasonPayload({
        riskReason,
        forceAsk: input.forceAsk === true,
        hasExternalPaths: true,
      });
      return {
        ...base,
        action: "ask",
        reason: reasonPayload.reason,
        reasonCodes: reasonPayload.reasonCodes,
        secondaryReasons: reasonPayload.secondaryReasons,
      };
    }

    if (!riskRequiresApproval) {
      return {
        ...base,
        action: "allow",
        reason: allowReason,
      };
    }

    return {
      ...base,
      action: "ask",
      reason: riskReason,
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

function normalizeSessionId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function buildApprovalReasonPayload(input: {
  riskReason: string;
  forceAsk: boolean;
  hasExternalPaths: boolean;
}): { reason: string; reasonCodes: string[]; secondaryReasons: string[] } {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const normalizedRiskReason = input.riskReason.trim();
  if (normalizedRiskReason || input.forceAsk) {
    reasonCodes.push("ask-risk");
    reasons.push(normalizedRiskReason || "当前策略要求人工审批");
  }
  if (input.hasExternalPaths) {
    reasonCodes.push("ask-path");
    reasons.push("路径越界访问需要审批");
  }
  if (!reasons.length) {
    return {
      reason: "",
      reasonCodes: [],
      secondaryReasons: [],
    };
  }
  return {
    reason: reasons[reasons.length - 1]!,
    reasonCodes,
    secondaryReasons: reasons.slice(0, -1),
  };
}
