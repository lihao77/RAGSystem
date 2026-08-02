import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { ChildAgentInfo } from "../src/contracts/conversation-store/index.js";
import type { AgentDelegationStorePort } from "../src/contracts/runtime/core-runtime-ports.js";
import { toSessionIdentity, type SessionInfo } from "../src/contracts/session/session.js";
import { createDelegationTools } from "../src/tools/DelegationTools/DelegationTools.js";
import { BackgroundTaskService } from "../src/services/runtime/background-task-service.js";
import { AgentDelegationService } from "../src/services/agent/delegation/index.js";
import { createResumeExecutor } from "../src/services/agent/execution/resume-executor.js";
import type { DelegationPort } from "../src/services/agent/delegation/port.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parentAgent(background: boolean): AgentConfig {
  return AgentConfigSchema.parse({
    agent_name: "parent",
    tasks: { background },
    delegation: { enabled_agents: ["worker"] },
  });
}

function workerAgent(): AgentConfig {
  return AgentConfigSchema.parse({
    agent_name: "worker",
    display_name: "Worker",
    llm_tiers: { default: { provider: "provider", model_name: "model" } },
  });
}

function session(): SessionInfo {
  return {
    session_id: "session-1",
    tenant_id: "tenant-1" as SessionInfo["tenant_id"],
    owner_user_id: null,
    visibility: "private",
    origin_type: "direct",
    origin_id: null,
    origin_channel: "api",
    workspace_id: null,
    permission_mode: null,
    metadata: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function childAgent(): ChildAgentInfo {
  return {
    child_agent_id: "child_worker",
    session_id: "session-1",
    agent_name: "worker",
    thread_key: "child:child_worker",
    status: "active",
    created_seq: null,
    created_by_run_id: "parent-run",
    created_by_call_id: "parent-call",
    parent_run_id: "parent-run",
    parent_call_id: "parent-call",
    last_run_id: null,
    metadata: { agent_call_id: "child-call" },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function context(signal: AbortSignal) {
  return {
    sessionId: "session-1",
    runId: "parent-run",
    rootRunId: "parent-run",
    taskId: "parent-task",
    requestId: "request-1",
    parentCallId: null,
    toolCallId: "parent-call",
    currentCallId: "parent-call",
    round: 1,
    order: 0,
    roundIndex: 0,
    signal,
  };
}

function runtimeCore(worker: AgentConfig) {
  return {
    resolveExecutionConfig: vi.fn(() => ({
      readiness: { configuration_ready: true, requirements: [] },
      agent: worker,
      provider: { key: "provider", name: "Provider", provider_type: "openai" } as never,
      modelName: "model",
    })),
  } as never;
}

function store(child: ChildAgentInfo): AgentDelegationStorePort {
  return {
    getSession: vi.fn(async () => session()),
    addMessage: vi.fn(async () => ({}) as never),
    getRecentMessages: vi.fn(async () => []),
    getRun: vi.fn(async () => null),
    updateRunStatus: vi.fn(async () => true),
    createChildAgent: vi.fn(async () => child),
    findChildAgentByCreator: vi.fn(async () => null),
    getChildAgent: vi.fn(async () => child),
    listChildAgents: vi.fn(async () => ({ items: [child], total: 1 })),
    updateChildAgentLastRun: vi.fn(async () => true),
  };
}

describe("background child-agent delegation", () => {
  it("exposes the background switch only when tasks.background is enabled", () => {
    const delegation = {} as DelegationPort;
    const enabled = createDelegationTools({
      agent: parentAgent(true),
      teamName: null,
      getAgentDelegation: () => delegation,
    });
    const disabled = createDelegationTools({
      agent: parentAgent(false),
      teamName: null,
      getAgentDelegation: () => delegation,
    });

    const enabledCall = enabled.find((tool) => tool.name === "call_agent");
    const disabledCall = disabled.find((tool) => tool.name === "call_agent");
    expect(enabledCall?.parameters.properties).toHaveProperty("run_in_background");
    expect(disabledCall?.parameters.properties).not.toHaveProperty("run_in_background");
    expect(disabledCall?.parameters.properties).not.toHaveProperty("runInBackground");
  });

  it("returns separate background/task/run ids and does not inherit the parent abort signal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-"));
    tempRoots.push(root);
    const backgroundTasks = new BackgroundTaskService();
    const worker = workerAgent();
    const child = childAgent();
    let finishRun!: () => void;
    const executeRun = vi.fn(({ abortController }: { abortController: AbortController; ownsRunLease?: boolean }) => new Promise<{ success: boolean; content: string }>((resolve) => {
      finishRun = () => resolve({ success: true, content: "worker result" });
      abortController.signal.addEventListener("abort", () => resolve({ success: false, content: "aborted" }), { once: true });
    }));
    const runEngine = { executeRun } as never;
    const service = new AgentDelegationService(store(child), runtimeCore(worker), null, backgroundTasks, root);
    service.setRunEngine(() => runEngine);
    const parentAbort = new AbortController();

    const result = await service.callAgent({
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "do work", runInBackground: true, callId: "parent-call" },
    }, context(parentAbort.signal));

    const content = result.content as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(content).toEqual(expect.objectContaining({
      task_id: expect.any(String),
      background_started: true,
      status: "running",
      child_agent_id: expect.any(String),
      run_id: expect.any(String),
      background_task_id: expect.any(String),
    }));
    expect(content.task_id).toBe(content.background_task_id);

    parentAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backgroundTasks.getTaskSnapshot(String(content.background_task_id))?.status).toBe("running");

    finishRun();
    await waitFor(() => backgroundTasks.getTaskSnapshot(String(content.background_task_id))?.status === "completed");
    expect(executeRun).toHaveBeenCalledOnce();
    expect(executeRun.mock.calls[0]?.[0].ownsRunLease).toBe(true);
  });

  it("completes the background task while leaving an interaction child suspended", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-"));
    tempRoots.push(root);
    const backgroundTasks = new BackgroundTaskService();
    const worker = workerAgent();
    const child = childAgent();
    const executeRun = vi.fn(async () => ({
      success: false,
      content: "waiting",
      suspended: true,
      interactionKind: "user_input" as const,
    }));
    const service = new AgentDelegationService(store(child), runtimeCore(worker), null, backgroundTasks, root);
    service.setRunEngine(() => ({ executeRun } as never));

    const result = await service.callAgent({
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "ask the user", runInBackground: true, callId: "parent-call" },
    }, context(new AbortController().signal));
    const taskId = String((result.content as Record<string, unknown>).background_task_id);

    await waitFor(() => backgroundTasks.getTaskSnapshot(taskId)?.status === "completed");
    const output = JSON.parse(backgroundTasks.readOutput(taskId) ?? "{}");
    expect(output.success).toBe(true);
    expect(output.result).toEqual(expect.objectContaining({
      success: true,
      suspended: true,
      interaction_kind: "user_input",
    }));
  });

  it("stops a background child run through task_stop's cancellation hook", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-"));
    tempRoots.push(root);
    const backgroundTasks = new BackgroundTaskService();
    const worker = workerAgent();
    const child = childAgent();
    const executeRun = vi.fn(({ abortController }: { abortController: AbortController }) => new Promise<{ success: boolean; content: string }>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve({ success: false, content: "aborted" }), { once: true });
    }));
    const service = new AgentDelegationService(store(child), runtimeCore(worker), null, backgroundTasks, root);
    service.setRunEngine(() => ({ executeRun } as never));

    const result = await service.callAgent({
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "long work", runInBackground: true, callId: "parent-call" },
    }, context(new AbortController().signal));
    const taskId = String((result.content as Record<string, unknown>).background_task_id);

    await waitFor(() => executeRun.mock.calls.length === 1);
    expect(backgroundTasks.cancel(taskId)).toBe(true);
    await waitFor(() => backgroundTasks.getTaskSnapshot(taskId)?.status === "cancelled");
    expect(executeRun).toHaveBeenCalledOnce();
  });

  it("resumes an independently leased child with its durable execution context", async () => {
    const worker = workerAgent();
    const executeRun = vi.fn(async (_input: Record<string, any>) => ({ success: true, content: "done" }));
    const resume = createResumeExecutor({
      runEngine: { executeRun } as never,
      runtimeCore: runtimeCore(worker),
    });
    const claim = {
      claimed: true as const,
      claimId: "claim-1",
      batchId: "batch-1",
      rootRunId: "child-run",
      rootCallId: "child-call",
      agentName: "worker",
      threadKey: "child:child_worker",
      parentRunId: "parent-run",
      parentCallId: "parent-tool-call",
      lineageParentCallId: "parent-call",
      childAgentId: "child_worker",
      workspaceRoot: "C:\\workspace",
      task: "continue the child task",
      requestId: "request-1",
      executionKind: "call_agent",
      userId: null,
      sessionIdentity: toSessionIdentity(session()),
      resolutions: [],
    };

    const started = resume.startClaim({ sessionId: "session-1", claim });
    await started.promise;
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "child-run",
      rootCallId: "child-call",
      interactionRootCallId: "child-call",
      parentRunId: "parent-run",
      parentCallId: "parent-tool-call",
      lineageParentCallId: "parent-call",
      childAgentId: "child_worker",
      ownsRunLease: true,
      threadKey: "child:child_worker",
    }));
    const executeInput = executeRun.mock.calls[0]?.[0];
    expect(executeInput?.agent?.custom_params?.workspace_root).toBe("C:\\workspace");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
