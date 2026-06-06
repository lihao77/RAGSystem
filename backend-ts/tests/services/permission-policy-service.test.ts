import { describe, expect, it } from "vitest";

import { PermissionPolicyService } from "../../src/services/permission-policy-service.js";
import type { PermissionMode, RiskLevel } from "../../src/contracts/permissions.js";

describe("PermissionPolicyService", () => {
  it("matches the Python-compatible approval mode matrix", () => {
    const service = new PermissionPolicyService();
    const cases: Array<{
      mode: PermissionMode;
      riskLevel: RiskLevel;
      action: "allow" | "ask";
      reason: string;
    }> = [
      { mode: "strict", riskLevel: "low", action: "ask", reason: "严格模式：low 风险工具需要审批" },
      { mode: "strict", riskLevel: "medium", action: "ask", reason: "严格模式：medium 风险工具需要审批" },
      { mode: "strict", riskLevel: "high", action: "ask", reason: "严格模式：high 风险工具需要审批" },
      { mode: "standard", riskLevel: "low", action: "allow", reason: "" },
      { mode: "standard", riskLevel: "medium", action: "ask", reason: "标准模式：medium 风险工具需要审批" },
      { mode: "standard", riskLevel: "high", action: "ask", reason: "标准模式：high 风险工具需要审批" },
      { mode: "relaxed", riskLevel: "low", action: "allow", reason: "" },
      { mode: "relaxed", riskLevel: "medium", action: "allow", reason: "" },
      { mode: "relaxed", riskLevel: "high", action: "ask", reason: "宽松模式：高风险工具需要审批" },
      {
        mode: "dangerously_skip_permissions",
        riskLevel: "high",
        action: "allow",
        reason: "dangerously_skip_permissions 模式，跳过审批",
      },
    ];

    for (const item of cases) {
      service.setMode(item.mode);
      expect(
        service.evaluateToolApproval({
          toolName: "demo_tool",
          riskLevel: item.riskLevel,
          description: "Demo tool",
          arguments: {},
        }),
      ).toMatchObject({
        action: item.action,
        riskLevel: item.riskLevel,
        permissionMode: item.mode,
        reason: item.reason,
      });
    }
  });

  it("lets auto-accept patterns override strict mode", () => {
    const service = new PermissionPolicyService();
    service.setPolicy({
      mode: "strict",
      auto_accept_patterns: [
        {
          pattern_type: "tool_name",
          pattern_value: "read_*",
          description: "read-only tools",
        },
      ],
      audit_all_checks: false,
      approval_timeout: 300,
      skip_all_approvals: false,
    });

    expect(
      service.evaluateToolApproval({
        toolName: "read_memory_entry",
        riskLevel: "low",
        description: "Read memory",
        arguments: {},
      }),
    ).toMatchObject({
      action: "allow",
      reason: "工具名匹配规则 'read_*' 自动接受",
    });
  });
});
