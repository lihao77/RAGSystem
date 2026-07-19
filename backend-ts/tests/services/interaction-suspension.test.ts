import { describe, expect, it, vi } from "vitest";

import { RecoverableInterrupt } from "@ragsystem/agent-protocol";
import { createHookRegistry, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { registerGateHook } from "../../src/services/agent/sdk/gate-hook.js";
import type { PathAccessPolicy } from "../../src/contracts/path-access-policy.js";
import type { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import type { PermissionPolicyService } from "../../src/services/runtime/permission-policy-service.js";
import { createRequestUserInputTools } from "../../src/tools/RequestUserInputTool/RequestUserInputTool.js";

function daemonToolContext(): ToolExecContext {
  return {
    sessionId: "session-1",
    runId: "child-run",
    rootRunId: "root-run",
    parentRunId: "root-run",
    runParentCallId: "agent-call-1",
    taskId: "task-1",
    requestId: "request-1",
    parentCallId: "child-root-call",
    toolCallId: "tool-call-1",
    round: 0,
    order: 1,
    roundIndex: 0,
    executionKind: "daemon.webhook",
    currentAgentName: "worker",
  };
}

describe("交互工具挂起语义", () => {
  it("gate-hook 对 daemon 使用统一 deadline 并透传 run 树", async () => {
    const interrupt = new RecoverableInterrupt({
      sessionId: "session-1",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "agent-call-1",
      toolCallId: "tool-call-1",
      kind: "approval",
    });
    const waitForApproval = vi.fn(async () => { throw interrupt; });
    const hooks = createHookRegistry();
    registerGateHook(hooks, {
      permissionPolicy: {
        evaluateToolApproval: () => ({
          action: "ask",
          toolName: "execute_bash",
          riskLevel: "high",
          description: "执行命令",
          permissionMode: "standard",
          reason: "需要审批",
          reasonCodes: ["ask-risk"],
          secondaryReasons: [],
          externalPathCandidates: [],
        }),
      } as unknown as PermissionPolicyService,
      pendingInteractions: { waitForApproval } as unknown as PendingInteractionService,
      pathService: { approve: vi.fn() } as unknown as PathAccessPolicy,
      agentName: "worker",
    });

    await expect(hooks.emit("tool.gate", {
      toolName: "execute_bash",
      arguments: { command: "echo ok" },
      ctx: daemonToolContext(),
      riskLevel: "high",
      access: { action: "ask", reason: "需要审批", signals: {} },
    })).rejects.toBe(interrupt);
    expect(waitForApproval).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "agent-call-1",
      toolCallId: "tool-call-1",
      deadlineMs: 120_000,
    }));
  });

  it("request_user_input 对 daemon 使用统一 deadline", async () => {
    const interrupt = new RecoverableInterrupt({
      sessionId: "session-1",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "agent-call-1",
      toolCallId: "tool-call-1",
      kind: "user_input",
    });
    const waitForUserInput = vi.fn(async () => { throw interrupt; });
    const tool = createRequestUserInputTools({
      pendingInteractions: { waitForUserInput } as unknown as PendingInteractionService,
      agent: { agent_name: "worker" } as AgentConfig,
    })[0]!;

    await expect(tool.call({ prompt: "请选择" }, daemonToolContext())).rejects.toBe(interrupt);
    expect(waitForUserInput).toHaveBeenCalledWith(expect.objectContaining({
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "agent-call-1",
      deadlineMs: 120_000,
    }));
  });
});
