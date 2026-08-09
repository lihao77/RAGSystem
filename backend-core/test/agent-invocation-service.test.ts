import { describe, expect, it, vi } from "vitest";

import type {
  AgentInvocationChildInput,
  AgentInvocationRootInput,
} from "../src/contracts/execution/agent-invocation.js";
import { AgentInvocationService } from "../src/services/agent/execution/invocation-service.js";

const identity = {
  sessionId: "session-1",
  ownerUserId: "user-1",
  visibility: "private" as const,
  originType: "direct" as const,
  originId: null,
  originChannel: "api" as const,
  workspaceId: null,
  metadata: {},
  permissionMode: null,
};

const agent = { agent_name: "worker" } as AgentInvocationRootInput["agent"];
const provider = { name: "provider", provider_type: "openai" } as AgentInvocationRootInput["provider"];

describe("AgentInvocationService", () => {
  it("maps a root create invocation to startRun", async () => {
    const startRun = vi.fn(() => ({
      started: true,
      session_id: "session-1",
      run_id: "root-run",
      task_id: "root-task",
      request_id: "request-1",
      kind: "agent_run" as const,
      durableStarted: Promise.resolve({ kind: "started" as const }),
      promise: Promise.resolve({ content: "done", success: true }),
    }));
    const service = new AgentInvocationService({ startRun } as never);

    const request: AgentInvocationRootInput = {
      scope: "root",
      mode: "create",
      execution: "foreground",
      sessionId: "session-1",
      sessionIdentity: identity,
      requestId: "request-1",
      task: "run root",
      executionKind: "agent_stream",
      agent,
      provider,
      modelName: "model",
    };
    const handle = service.invoke(request);

    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      task: "run root",
      resume: false,
    }));
    await expect(handle.promise).resolves.toMatchObject({
      content: "done",
      success: true,
      runId: "root-run",
    });
  });

  it("maps a child resume invocation to executeRun and owns its abort controller", async () => {
    const executeRun = vi.fn(async (input: {
      abortController: AbortController;
      onStartDisposition: (disposition: { kind: "started" }) => void;
    }) => {
      expect(input.abortController).toBeInstanceOf(AbortController);
      input.onStartDisposition({ kind: "started" });
      return { content: "child done", success: true };
    });
    const service = new AgentInvocationService({ executeRun } as never);
    const externalAbort = new AbortController();
    const request: AgentInvocationChildInput = {
      scope: "child",
      mode: "resume",
      execution: "background",
      sessionId: "session-1",
      sessionIdentity: identity,
      requestId: "request-2",
      task: "resume child",
      executionKind: "agent",
      agent,
      provider,
      modelName: "model",
      runId: "child-run",
      taskId: "child-task",
      rootCallId: "child-call",
      startedAt: new Date(0),
      threadKey: "child:child-1",
      parentRunId: "parent-run",
      parentCallId: "parent-call",
      childAgentId: "child-1",
      ownsRunLease: true,
      signal: externalAbort.signal,
    };

    const handle = service.invoke(request);
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "child-run",
      threadKey: "child:child-1",
      parentRunId: "parent-run",
      childAgentId: "child-1",
      ownsRunLease: true,
      abortController: expect.any(AbortController),
    }));
    expect(executeRun.mock.calls[0]?.[0]).not.toHaveProperty("scope");
    expect(executeRun.mock.calls[0]?.[0]).not.toHaveProperty("mode");
    await expect(handle.durableStarted).resolves.toEqual({ kind: "started" });
    await expect(handle.promise).resolves.toMatchObject({
      content: "child done",
      success: true,
      runId: "child-run",
    });

    externalAbort.abort();
    expect(executeRun.mock.calls[0]?.[0].abortController.signal.aborted).toBe(true);
  });

  it("aborts a child invocation when its execution timeout elapses", async () => {
    const executeRun = vi.fn((input: { abortController: AbortController; onStartDisposition: (disposition: { kind: "started" }) => void }) => {
      input.onStartDisposition({ kind: "started" });
      return new Promise<{ content: string; success: boolean }>((resolve) => {
        input.abortController.signal.addEventListener("abort", () => {
          resolve({ content: "timed out", success: false });
        }, { once: true });
      });
    });
    const service = new AgentInvocationService({ executeRun } as never);
    const handle = service.invoke({
      scope: "child",
      mode: "create",
      execution: "foreground",
      sessionId: "session-1",
      sessionIdentity: identity,
      requestId: "request-timeout",
      task: "bounded child",
      executionKind: "agent",
      agent,
      provider,
      modelName: "model",
      runId: "child-timeout",
      taskId: "child-task",
      rootCallId: "child-call",
      startedAt: new Date(),
      threadKey: "child:child-1",
      timeoutMs: 10,
    });

    await expect(handle.promise).resolves.toMatchObject({ success: false, content: "timed out" });
    expect(executeRun.mock.calls[0]?.[0].abortController.signal.aborted).toBe(true);
  });
});
