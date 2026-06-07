import { describe, expect, it } from "vitest";

import { PermissionPolicyService } from "../../src/services/runtime/permission-policy-service.js";
import type { PermissionMode, PermissionPolicy, RiskLevel } from "../../src/contracts/permissions.js";

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

  it("lets auto-accept patterns override forced risk approval while preserving path approval", () => {
    const service = new PermissionPolicyService();
    service.setPolicy({
      mode: "standard",
      auto_accept_patterns: [
        {
          pattern_type: "tool_name",
          pattern_value: "execute_bash",
          description: "trusted bash",
        },
      ],
      audit_all_checks: false,
      approval_timeout: 300,
      skip_all_approvals: false,
    });

    expect(
      service.evaluateToolApproval({
        toolName: "execute_bash",
        riskLevel: "medium",
        description: "Execute bash",
        arguments: { command: "mkdir out" },
        forceAsk: true,
      }),
    ).toMatchObject({
      action: "allow",
      reason: "工具名匹配规则 'execute_bash' 自动接受",
    });

    expect(
      service.evaluateToolApproval({
        toolName: "execute_bash",
        riskLevel: "medium",
        description: "Execute bash",
        arguments: { command: "mkdir out", working_dir: "C:\\outside" },
        forceAsk: true,
        approvedExternalPaths: ["C:\\outside"],
      }),
    ).toMatchObject({
      action: "ask",
      reason: "路径越界访问需要审批",
      reasonCodes: ["ask-risk", "ask-path"],
      secondaryReasons: ["工具名匹配规则 'execute_bash' 自动接受"],
      approvedExternalPaths: ["C:\\outside"],
    });
  });

  it("uses session permission overrides without changing the global policy", () => {
    const service = new PermissionPolicyService();
    service.setMode("relaxed");
    const strictPolicy: PermissionPolicy = {
      mode: "strict",
      auto_accept_patterns: [],
      audit_all_checks: false,
      approval_timeout: 300,
      skip_all_approvals: false,
    };
    service.setSessionPermissionOverride("s-strict", strictPolicy);

    expect(
      service.evaluateToolApproval({
        toolName: "read_file",
        riskLevel: "low",
        description: "Read file",
        arguments: {},
        sessionId: "s-strict",
      }),
    ).toMatchObject({
      action: "ask",
      permissionMode: "strict",
      reason: "严格模式：low 风险工具需要审批",
    });
    expect(
      service.evaluateToolApproval({
        toolName: "read_file",
        riskLevel: "low",
        description: "Read file",
        arguments: {},
        sessionId: "s-relaxed",
      }),
    ).toMatchObject({
      action: "allow",
      permissionMode: "relaxed",
      reason: "",
    });

    service.clearSessionPermissionOverride("s-strict");
    expect(
      service.evaluateToolApproval({
        toolName: "read_file",
        riskLevel: "low",
        description: "Read file",
        arguments: {},
        sessionId: "s-strict",
      }),
    ).toMatchObject({
      action: "allow",
      permissionMode: "relaxed",
    });
  });

  it("requires approval for approved external paths and preserves Python reason payloads", () => {
    const service = new PermissionPolicyService();
    service.setMode("standard");

    expect(
      service.evaluateToolApproval({
        toolName: "read_file",
        riskLevel: "low",
        description: "Read file",
        arguments: { file_path: "C:\\outside\\note.txt" },
        approvedExternalPaths: ["C:\\outside\\note.txt"],
      }),
    ).toMatchObject({
      action: "ask",
      reason: "路径越界访问需要审批",
      reasonCodes: ["ask-path"],
      secondaryReasons: [],
      approvedExternalPaths: ["C:\\outside\\note.txt"],
    });

    expect(
      service.evaluateToolApproval({
        toolName: "write_file",
        riskLevel: "high",
        description: "Write file",
        arguments: { file_path: "C:\\outside\\note.txt" },
        approvedExternalPaths: ["C:\\outside\\note.txt"],
      }),
    ).toMatchObject({
      action: "ask",
      reason: "路径越界访问需要审批",
      reasonCodes: ["ask-risk", "ask-path"],
      secondaryReasons: ["标准模式：high 风险工具需要审批"],
      approvedExternalPaths: ["C:\\outside\\note.txt"],
    });
  });
});
