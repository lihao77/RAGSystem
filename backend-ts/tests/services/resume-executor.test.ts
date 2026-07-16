import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { createResumeExecutor } from "../../src/services/agent/execution/resume-executor.js";
import type { AgentRunEngine } from "../../src/services/agent/execution/run-engine.js";
import type { RuntimeExecutionConfigResolver } from "../../src/services/agent/execution/runtime-core-service.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";

describe("ResumeExecutor", () => {
  it("复用 rootRunId 恢复并在完成后回调", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "session-resume", "usr_local", { team: "default" });
    store.createRun({
      runId: "root-run",
      sessionId: "session-resume",
      status: "suspended",
      taskSummary: "根任务",
      requestId: "request-1",
      userId: "usr_local",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    store.addRunStep({
      sessionId: "session-resume",
      runId: "root-run",
      stepType: "protocol.envelope.v1",
      payload: {
        type: "agent_started",
        session_id: "session-resume",
        run_id: "root-run",
        call_id: "root-call",
        payload: { phase: "start", task: "根任务" },
      },
    });

    const realtimeEvents = new RealtimeEventHub();
    const pendingInteractions = new PendingInteractionService(
      new DurableClientEventPublisher(store, new OutboxDispatcher(store, realtimeEvents)),
      store,
    );
    const suspended = pendingInteractions.waitForApproval({
      sessionId: "session-resume",
      runId: "child-run",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentCallId: "call-agent-1",
      toolCallId: "approval-tool-call",
      deadlineMs: 0,
      task: "完整根任务",
      executionKind: "daemon.cron",
      toolName: "execute_bash",
    });
    const approvalId = realtimeEvents.getHistory("session-resume").at(-1)?.call_id ?? "";
    await expect(suspended).rejects.toBeDefined();
    pendingInteractions.respondApproval("session-resume", approvalId, { approved: true, message: "继续" });

    const startRun = vi.fn(() => ({
      started: true,
      session_id: "session-resume",
      run_id: "root-run",
      task_id: "resume-task",
      request_id: "request-1",
      kind: "agent_run" as const,
      promise: Promise.resolve({ content: "完成", success: true }),
    }));
    const onCompleted = vi.fn();
    const executor = createResumeExecutor({
      runEngine: { startRun } as unknown as AgentRunEngine,
      conversationStore: store,
      pendingInteractions,
      runtimeCore: runtimeCoreStub(),
    });

    expect(executor.resumeRun({
      sessionId: "session-resume",
      approvalId,
      resolution: { approved: true, message: "继续" },
      onCompleted,
    })).toEqual({
      rootRunId: "root-run",
      approvalId,
      toolCallId: "approval-tool-call",
    });
    expect(store.getRun("session-resume", "root-run")?.status).toBe("running");
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-resume",
      runId: "root-run",
      rootCallId: "root-call",
      resume: true,
      task: "完整根任务",
      executionKind: "daemon.cron",
    }));
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledWith({ content: "完成", success: true }));
    store.close();
  });

  it("恢复启动失败会回滚 run 与 batch，允许再次恢复", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "session-retry", "usr_local");
    store.createRun({
      runId: "root-retry",
      sessionId: "session-retry",
      status: "suspended",
      taskSummary: "恢复重试",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    const realtimeEvents = new RealtimeEventHub();
    const pendingInteractions = new PendingInteractionService(
      new DurableClientEventPublisher(store, new OutboxDispatcher(store, realtimeEvents)),
      store,
    );
    const wait = pendingInteractions.waitForApproval({
      sessionId: "session-retry",
      runId: "root-retry",
      rootRunId: "root-retry",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-retry",
      interactionBatchId: "batch-retry",
      deadlineMs: 0,
      task: "恢复重试",
      toolName: "write_file",
    });
    const approvalId = realtimeEvents.getHistory("session-retry")[0]?.call_id ?? "";
    await expect(wait).rejects.toBeDefined();
    pendingInteractions.respondApproval("session-retry", approvalId, { approved: true, message: "批准" });

    const failingExecutor = createResumeExecutor({
      runEngine: { startRun: () => { throw new Error("start failed"); } } as unknown as AgentRunEngine,
      conversationStore: store,
      pendingInteractions,
      runtimeCore: runtimeCoreStub(),
    });
    expect(() => failingExecutor.resumeRun({
      sessionId: "session-retry",
      approvalId,
      resolution: { approved: true, message: "批准" },
    })).toThrow("start failed");
    expect(store.getRun("session-retry", "root-retry")?.status).toBe("suspended");
    expect(store.getPendingInteraction("session-retry", approvalId)?.status).toBe("resolved");

    const startRun = vi.fn(() => ({
      started: true,
      session_id: "session-retry",
      run_id: "root-retry",
      task_id: "retry-task",
      request_id: "retry-request",
      kind: "agent_run" as const,
      promise: Promise.resolve({ content: "完成", success: true }),
    }));
    const retryExecutor = createResumeExecutor({
      runEngine: { startRun } as unknown as AgentRunEngine,
      conversationStore: store,
      pendingInteractions,
      runtimeCore: runtimeCoreStub(),
    });
    expect(() => retryExecutor.resumeRun({
      sessionId: "session-retry",
      approvalId,
      resolution: { approved: true, message: "批准" },
    })).not.toThrow();
    expect(startRun).toHaveBeenCalledOnce();
    store.close();
  });

  it("同一批仍有未响应审批时拒绝恢复", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "session-partial", "usr_local");
    store.createRun({
      runId: "root-partial",
      sessionId: "session-partial",
      status: "suspended",
      taskSummary: "部分审批",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    const realtimeEvents = new RealtimeEventHub();
    const pendingInteractions = new PendingInteractionService(
      new DurableClientEventPublisher(store, new OutboxDispatcher(store, realtimeEvents)),
      store,
    );
    const common = {
      sessionId: "session-partial",
      runId: "root-partial",
      rootRunId: "root-partial",
      parentRunId: null,
      parentCallId: null,
      interactionBatchId: "batch-partial",
      deadlineMs: 0,
      task: "部分审批",
      toolName: "write_file",
    };
    const firstWait = pendingInteractions.waitForApproval({ ...common, toolCallId: "tool-first" });
    const secondWait = pendingInteractions.waitForApproval({ ...common, toolCallId: "tool-second" });
    const [firstId] = realtimeEvents.getHistory("session-partial").map((event) => event.call_id ?? "");
    await expect(Promise.allSettled([firstWait, secondWait])).resolves.toHaveLength(2);
    pendingInteractions.respondApproval("session-partial", firstId!, { approved: true, message: "只批准一个" });

    const startRun = vi.fn();
    const executor = createResumeExecutor({
      runEngine: { startRun } as unknown as AgentRunEngine,
      conversationStore: store,
      pendingInteractions,
      runtimeCore: runtimeCoreStub(),
    });
    expect(() => executor.resumeRun({
      sessionId: "session-partial",
      approvalId: firstId!,
      resolution: { approved: true, message: "只批准一个" },
    })).toThrow("审批批次尚未全部响应");
    expect(store.getRun("session-partial", "root-partial")?.status).toBe("suspended");
    expect(startRun).not.toHaveBeenCalled();
    store.close();
  });
});

function runtimeCoreStub(): RuntimeExecutionConfigResolver {
  const agent = {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator",
    custom_params: {},
  } as unknown as AgentConfig;
  const provider = {
    key: "test",
    name: "test",
    provider_type: "openai",
  } as unknown as ModelProviderConfig;
  const readiness = {
    configuration_ready: true,
    requirements: [],
  } as unknown as ReturnType<RuntimeExecutionConfigResolver["getReadiness"]>;
  return {
    getReadiness: () => readiness,
    resolveExecutionConfig: () => ({ readiness, agent, provider, modelName: "test-model" }),
  };
}
