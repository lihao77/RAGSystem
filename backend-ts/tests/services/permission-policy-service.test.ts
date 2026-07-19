import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PermissionMode, RiskLevel } from "../../src/contracts/permissions.js";
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../src/services/identity/index.js";
import { PermissionPolicyService } from "../../src/services/runtime/permission-policy-service.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { makeTempDb } from "../helpers/temp-db.js";

describe("PermissionPolicyService", () => {
  it("按 session.permission_mode 执行审批矩阵", () => {
    const dbPath = makeTempDb();
    const store = createConversationStore({ dbPath, dataRoot: path.dirname(dbPath) });
    const service = new PermissionPolicyService(store);
    const cases: Array<{ mode: PermissionMode; riskLevel: RiskLevel; action: "allow" | "ask"; reason: string }> = [
      { mode: "strict", riskLevel: "low", action: "ask", reason: "严格模式：low 风险工具需要审批" },
      { mode: "standard", riskLevel: "medium", action: "ask", reason: "标准模式：medium 风险工具需要审批" },
      { mode: "relaxed", riskLevel: "medium", action: "allow", reason: "" },
      { mode: "relaxed", riskLevel: "high", action: "ask", reason: "宽松模式：高风险工具需要审批" },
      { mode: "dangerously_skip_permissions", riskLevel: "high", action: "allow", reason: "dangerously_skip_permissions 模式，跳过审批" },
    ];

    for (const [index, item] of cases.entries()) {
      const sessionId = `policy-${index}`;
      store.createSession(LOCAL_TENANT_ID, sessionId, LOCAL_USER_ID, {}, item.mode);
      expect(service.evaluateToolApproval({
        sessionId,
        toolName: "demo_tool",
        riskLevel: item.riskLevel,
        description: "Demo tool",
        arguments: {},
      })).toMatchObject({
        action: item.action,
        permissionMode: item.mode,
        reason: item.reason,
      });
    }
    store.close();
  });

  it("会话不存在或 permission_mode 为 NULL 时回落 standard", () => {
    const dbPath = makeTempDb();
    const store = createConversationStore({ dbPath, dataRoot: path.dirname(dbPath) });
    store.createSession(LOCAL_TENANT_ID, "default-policy", LOCAL_USER_ID);
    const service = new PermissionPolicyService(store);

    expect(service.getEffectivePolicy("missing")).toEqual(defaultPolicy());
    expect(service.getEffectivePolicy("default-policy")).toEqual(defaultPolicy());
    store.close();
  });

  it("超范围路径在非 YOLO 模式下始终需要审批", () => {
    const dbPath = makeTempDb();
    const store = createConversationStore({ dbPath, dataRoot: path.dirname(dbPath) });
    const service = new PermissionPolicyService(store);
    const candidatePath = "C:\\outside\\note.txt";
    const cases: Array<{
      mode: PermissionMode;
      riskLevel: RiskLevel;
      action: "allow" | "ask";
      reason: string;
      reasonCodes: string[];
    }> = [
      {
        mode: "dangerously_skip_permissions",
        riskLevel: "high",
        action: "allow",
        reason: "dangerously_skip_permissions 模式，跳过审批",
        reasonCodes: [],
      },
      {
        mode: "relaxed",
        riskLevel: "high",
        action: "ask",
        reason: "工作目录外路径需要用户审批",
        reasonCodes: ["external-path"],
      },
      {
        mode: "standard",
        riskLevel: "low",
        action: "ask",
        reason: "工作目录外路径需要用户审批",
        reasonCodes: ["external-path"],
      },
      {
        mode: "strict",
        riskLevel: "low",
        action: "ask",
        reason: "工作目录外路径需要用户审批",
        reasonCodes: ["external-path"],
      },
    ];

    for (const item of cases) {
      const sessionId = `external-path-${item.mode}`;
      store.createSession(LOCAL_TENANT_ID, sessionId, LOCAL_USER_ID, {}, item.mode);
      expect(service.evaluateToolApproval({
        sessionId,
        toolName: "read_file",
        riskLevel: item.riskLevel,
        description: "Read file",
        arguments: { file_path: candidatePath },
        externalPathCandidates: [candidatePath],
      })).toMatchObject({
        action: item.action,
        reason: item.reason,
        reasonCodes: item.reasonCodes,
        permissionMode: item.mode,
        externalPathCandidates: [candidatePath],
      });
    }
    store.close();
  });
});

function defaultPolicy() {
  return {
    mode: "standard",
    auto_accept_patterns: [],
    audit_all_checks: false,
    approval_timeout: 300,
    skip_all_approvals: false,
  };
}
