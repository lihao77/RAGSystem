import type { AutoAcceptPattern, PermissionMode, PermissionPolicy } from "../contracts/permissions.js";

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
