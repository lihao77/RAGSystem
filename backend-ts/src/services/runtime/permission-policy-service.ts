import { asString } from "../../utils/guards.js";
import type { PermissionMode, PermissionPolicy, RiskLevel } from "../../contracts/runtime/permissions.js";
import type { PermissionPolicyStorePort } from "../../contracts/runtime/core-runtime-ports.js";

export interface RuntimeToolApprovalInput {
  toolName: string;
  riskLevel?: RiskLevel | null | undefined;
  description?: string | null | undefined;
  arguments?: Record<string, unknown> | undefined;
  sessionId?: string | null | undefined;
  /** 工具自声明审批豁免（checkAccess signals.approvalExempt，交互类工具）。 */
  approvalExempt?: boolean | undefined;
  /** 工具 checkAccess 声明 ask（高危/需审批）。 */
  toolAsksApproval?: boolean | undefined;
  /** 越界外部路径候选（checkAccess signals.candidatePaths，供授权与审计使用）。 */
  externalPathCandidates?: string[] | undefined;
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
  externalPathCandidates: string[];
}

export class PermissionPolicyService {
  constructor(private readonly store: PermissionPolicyStorePort) {}

  /** Refresh the synchronous policy snapshot before starting a run. */
  async prepareSession(sessionId?: string | null | undefined): Promise<void> {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (normalizedSessionId && this.store.prepareSession) {
      await this.store.prepareSession(normalizedSessionId);
    }
  }

  getEffectivePolicy(sessionId?: string | null | undefined): PermissionPolicy {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const mode = normalizedSessionId
      ? this.store.getSession(normalizedSessionId)?.permission_mode ?? "standard"
      : "standard";
    return {
      mode,
      auto_accept_patterns: [],
      audit_all_checks: false,
      approval_timeout: 300,
      skip_all_approvals: false,
    };
  }

  evaluateToolApproval(input: RuntimeToolApprovalInput): RuntimeToolApprovalDecision {
    const policy = this.getEffectivePolicy(input.sessionId);
    const toolName = input.toolName.trim();
    const riskLevel = input.riskLevel ?? "low";
    const description = input.description?.trim() || `Tool ${toolName}`;
    const externalPathCandidates = dedupeStrings(input.externalPathCandidates ?? []);
    const base = {
      toolName,
      riskLevel,
      description,
      permissionMode: policy.mode,
      reasonCodes: [],
      secondaryReasons: [],
      externalPathCandidates,
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

    // External paths are a separate boundary from command risk. In every
    // non-YOLO mode they require an explicit approval, including read-only
    // operations that would otherwise be considered low risk.
    if (externalPathCandidates.length && policy.mode !== "dangerously_skip_permissions") {
      return {
        ...base,
        action: "ask",
        reason: "工作目录外路径需要用户审批",
        reasonCodes: ["external-path"],
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
    } else if (input.toolAsksApproval) {
      riskRequiresApproval = true;
      riskReason = "当前策略要求人工审批";
    } else {
      riskReason = getModeApprovalReason(policy.mode, riskLevel);
      riskRequiresApproval = Boolean(riskReason);
    }

    // 超范围路径不单独强制审批，统一服从当前 mode 与工具风险等级。
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
