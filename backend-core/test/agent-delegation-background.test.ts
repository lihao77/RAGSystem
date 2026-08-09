import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFullSystemPrompt } from "@ragsystem/agent-sdk";

import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { ChildAgentInfo } from "../src/contracts/conversation-store/index.js";
import type { AgentDelegationStorePort } from "../src/contracts/runtime/core-runtime-ports.js";
import { toSessionIdentity, type SessionInfo } from "../src/contracts/session/session.js";
import { createDelegationTools } from "../src/tools/DelegationTools/DelegationTools.js";
import { BackgroundTaskService } from "../src/services/runtime/background-task-service.js";
import { AgentDelegationService } from "../src/services/agent/delegation/index.js";
import { createResumeExecutor } from "../src/services/agent/execution/resume-executor.js";
import { AgentInvocationService } from "../src/services/agent/execution/invocation-service.js";
import { buildChildMetadata } from "../src/services/agent/delegation/helpers.js";
import type {
  AgentDelegationCall,
  DelegationPort,
  SendMessageCall,
} from "../src/services/agent/delegation/port.js";

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
    tenantId: "tenant-1",
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
  it("routes a child progress message to the exact parent invocation", async () => {
    const delegationStore = store(childAgent());
    vi.mocked(delegationStore.getRun).mockResolvedValue({
      run_id: "parent-run",
      agent_call_id: "parent-call",
      agent_name: "parent",
      thread_key: "root",
      child_agent_id: null,
      parent_run_id: null,
      parent_call_id: null,
      lineage_parent_call_id: null,
      lease_root_run_id: "parent-run",
    } as never);
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      kind: input.kind,
      correlation_id: input.correlationId ?? null,
      expires_at: input.expiresAt ?? null,
    })) as never;
    const mailbox = { enqueue, get: vi.fn(), claim: vi.fn(), ack: vi.fn(), release: vi.fn(), expire: vi.fn() };
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      mailbox as never,
    );
    const wakeup = vi.fn();
    service.setMailboxWakeup(wakeup);

    const result = await invokeMessage(service, {
      agent: workerAgent(),
      teamName: null,
      input: {
        toParent: true,
        message: "progress from child",
        kind: "progress",
        correlationId: "corr-child",
        timeoutMs: 10_000,
        callId: "child-tool-call",
      },
    }, {
      ...context(new AbortController().signal),
      runId: "child-run",
      rootRunId: "parent-run",
      rootCallId: "child-call",
      currentCallId: "child-call",
      currentChildAgentId: "child_worker",
      parentRunId: "parent-run",
      runParentCallId: "parent-call",
      threadKey: "child:child_worker",
    } as never);

    expect(result.success).toBe(true);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      targetRunId: "parent-run",
      targetAgentCallId: "parent-call",
      targetThreadKey: "root",
      targetChildAgentId: null,
      kind: "progress",
      correlationId: "corr-child",
      metadata: expect.objectContaining({ direction: "child_to_parent" }),
      expiresAt: expect.any(String),
    }));
    expect(wakeup).toHaveBeenCalledWith(expect.objectContaining({
      targetRunId: "parent-run",
      targetAgentCallId: "parent-call",
      targetThreadKey: "root",
    }));
  });

  it("delivers an agent follow-up to a running child through the durable mailbox", async () => {
    const child = { ...childAgent(), last_run_id: "child-run" };
    const delegationStore = store(child);
    const runningRun = {
      run_id: "child-run",
      agent_call_id: "child-call",
      status: "running",
    };
    vi.mocked(delegationStore.getRun).mockResolvedValue(runningRun as never);
    const mailbox = {
      enqueue: vi.fn(async (input: Record<string, unknown>) => ({
        ...input,
        seq: 1,
        message_id: input.messageId,
        tenant_id: input.tenantId,
        session_id: input.sessionId,
        source_run_id: input.sourceRunId ?? null,
        source_agent_call_id: input.sourceAgentCallId ?? null,
        target_run_id: input.targetRunId ?? null,
        target_agent_call_id: input.targetAgentCallId ?? null,
        target_thread_key: input.targetThreadKey,
        target_child_agent_id: input.targetChildAgentId ?? null,
        kind: input.kind,
        correlation_id: input.correlationId ?? null,
        reply_to_message_id: input.replyToMessageId ?? null,
        content_parts: input.contentParts,
        metadata: input.metadata ?? {},
        status: "queued",
        attempt_count: 0,
        claim_id: null,
        claimed_by: null,
        claim_expires_at: null,
        available_at: new Date(0).toISOString(),
        expires_at: null,
        last_error: null,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        acked_at: null,
      })) as never,
      get: vi.fn(),
      claim: vi.fn(),
      ack: vi.fn(),
      release: vi.fn(),
      expire: vi.fn(),
    };
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      mailbox as never,
    );
    const invocation = vi.fn();
    service.setInvocationService({ invoke: invocation } as never);
    const wakeup = vi.fn();
    service.setMailboxWakeup(wakeup);

    const result = await invokeMessage(service, {
      agent: parentAgent(false),
      teamName: null,
      input: {
        childAgentId: child.child_agent_id,
        message: "please send progress",
        kind: "progress",
        correlationId: "corr-1",
        timeoutMs: 10_000,
        callId: "parent-tool-call",
      },
    }, context(new AbortController().signal));

    expect(result.success).toBe(true);
    expect(result.content).toEqual(expect.objectContaining({
      status: "queued",
      target_run_id: "child-run",
      kind: "progress",
      correlation_id: "corr-1",
    }));
    expect(mailbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      targetRunId: "child-run",
      targetAgentCallId: "child-call",
      targetChildAgentId: child.child_agent_id,
      kind: "progress",
      correlationId: "corr-1",
      sourceRunId: "parent-run",
      expiresAt: expect.any(String),
    }));
    expect(wakeup).toHaveBeenCalledWith(expect.objectContaining({
      targetRunId: "child-run",
      targetAgentCallId: "child-call",
      targetThreadKey: child.thread_key,
      targetChildAgentId: child.child_agent_id,
    }));
    expect(invocation).not.toHaveBeenCalled();
  });

  it("does not fork a suspended child when sending a follow-up", async () => {
    const child = { ...childAgent(), last_run_id: "suspended-child-run" };
    const delegationStore = store(child);
    vi.mocked(delegationStore.getRun).mockResolvedValue({
      run_id: "suspended-child-run",
      agent_call_id: "child-call",
      status: "suspended",
    } as never);
    const mailbox = {
      enqueue: vi.fn(),
      get: vi.fn(),
      claim: vi.fn(),
      ack: vi.fn(),
      release: vi.fn(),
      expire: vi.fn(),
    };
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      mailbox as never,
    );
    const invocation = vi.fn();
    service.setInvocationService({ invoke: invocation } as never);

    const result = await invokeMessage(service, {
      agent: parentAgent(false),
      teamName: null,
      input: {
        childAgentId: child.child_agent_id,
        message: "continue",
        kind: "request",
        callId: "parent-tool-call",
      },
    }, context(new AbortController().signal));

    expect(result.success).toBe(false);
    expect(String(result.content)).toContain("suspended");
    expect(mailbox.enqueue).not.toHaveBeenCalled();
    expect(invocation).not.toHaveBeenCalled();
  });

  it("does not create a new invocation when cancelling a completed child", async () => {
    const child = { ...childAgent(), last_run_id: "completed-child-run" };
    const delegationStore = store(child);
    vi.mocked(delegationStore.getRun).mockResolvedValue({
      run_id: "completed-child-run",
      agent_call_id: "child-call",
      status: "completed",
    } as never);
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      { enqueue: vi.fn(), get: vi.fn(), claim: vi.fn(), ack: vi.fn(), release: vi.fn(), expire: vi.fn() } as never,
    );
    const invocation = vi.fn();
    service.setInvocationService({ invoke: invocation } as never);

    const result = await invokeMessage(service, {
      agent: parentAgent(false),
      teamName: null,
      input: {
        childAgentId: child.child_agent_id,
        message: "stop",
        kind: "cancel",
        callId: "parent-tool-call",
      },
    }, context(new AbortController().signal));

    expect(result.success).toBe(true);
    expect(result.content).toEqual(expect.objectContaining({ status: "already_finished" }));
    expect(invocation).not.toHaveBeenCalled();
  });

  it("does not start a child when cancelling an idle child without a prior run", async () => {
    const child = childAgent();
    const delegationStore = store(child);
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      { enqueue: vi.fn(), get: vi.fn(), claim: vi.fn(), ack: vi.fn(), release: vi.fn(), expire: vi.fn() } as never,
    );
    const invocation = vi.fn();
    service.setInvocationService({ invoke: invocation } as never);

    const result = await invokeMessage(service, {
      agent: parentAgent(false),
      teamName: null,
      input: {
        childAgentId: child.child_agent_id,
        message: "stop",
        kind: "cancel",
        callId: "parent-tool-call",
      },
    }, context(new AbortController().signal));

    expect(result.success).toBe(true);
    expect(result.content).toEqual(expect.objectContaining({ status: "no_active_run" }));
    expect(invocation).not.toHaveBeenCalled();
  });

  it("keeps a durable send successful when the in-process wakeup throws", async () => {
    const child = { ...childAgent(), last_run_id: "child-run" };
    const delegationStore = store(child);
    vi.mocked(delegationStore.getRun).mockResolvedValue({
      run_id: "child-run",
      agent_call_id: "child-call",
      status: "running",
    } as never);
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      kind: input.kind,
      correlation_id: null,
      expires_at: null,
    })) as never;
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      { enqueue, get: vi.fn(), claim: vi.fn(), ack: vi.fn(), release: vi.fn(), expire: vi.fn() } as never,
    );
    service.setMailboxWakeup(() => { throw new Error("wakeup unavailable"); });

    const result = await invokeMessage(service, {
      agent: parentAgent(false),
      teamName: null,
      input: { childAgentId: child.child_agent_id, message: "ping", kind: "progress", callId: "parent-tool-call" },
    }, context(new AbortController().signal));

    expect(result.success).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("routes a terminal background child result to the exact parent mailbox target", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-result-"));
    tempRoots.push(root);
    const backgroundTasks = new BackgroundTaskService();
    const child = childAgent();
    const parentRun = {
      run_id: "parent-run",
      session_id: "session-1",
      tenant_id: "tenant-1",
      entrypoint: "agent_stream",
      status: "completed",
      task_summary: "parent task",
      terminal_reason: null,
      request_id: "request-1",
      user_id: null,
      agent_name: "parent",
      agent_call_id: "parent-agent-call",
      lineage_parent_call_id: null,
      agent_display_name: "Parent",
      lease_root_run_id: "parent-run",
      thread_key: "root",
      parent_run_id: null,
      parent_call_id: null,
      child_agent_id: null,
      final_message_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    const delegationStore = store(child);
    vi.mocked(delegationStore.getRun).mockResolvedValue(parentRun as never);
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      seq: 1,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      source_run_id: input.sourceRunId ?? null,
      source_agent_call_id: input.sourceAgentCallId ?? null,
      target_run_id: input.targetRunId ?? null,
      target_agent_call_id: input.targetAgentCallId ?? null,
      target_thread_key: input.targetThreadKey,
      target_child_agent_id: input.targetChildAgentId ?? null,
      kind: input.kind,
      correlation_id: input.correlationId ?? null,
      reply_to_message_id: null,
      content_parts: input.contentParts,
      metadata: input.metadata ?? {},
      status: "queued",
      attempt_count: 0,
      claim_id: null,
      claimed_by: null,
      claim_expires_at: null,
      available_at: new Date(0).toISOString(),
      expires_at: null,
      last_error: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      acked_at: null,
    })) as never;
    const mailbox = {
      enqueue,
      get: vi.fn(),
      claim: vi.fn(),
      ack: vi.fn(),
      release: vi.fn(),
      expire: vi.fn(),
    };
    const executeRun = vi.fn(async () => ({ success: true, content: "finished child work" }));
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      backgroundTasks,
      root,
      mailbox as never,
    );
    const wakeup = vi.fn();
    service.setMailboxWakeup(wakeup);
    service.setInvocationService(new AgentInvocationService({ executeRun } as never));

    const result = await invokeCreate(service, {
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "do work", timeoutMs: 4321, runInBackground: true, callId: "parent-call" },
    }, context(new AbortController().signal));
    const taskId = String((result.content as Record<string, unknown>).background_task_id);
    await waitFor(() => backgroundTasks.getTaskSnapshot(taskId)?.status === "completed");

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: expect.stringContaining(":terminal_result"),
      tenantId: "tenant-1",
      sourceRunId: expect.any(String),
      targetRunId: "parent-run",
      targetAgentCallId: "parent-agent-call",
      targetThreadKey: "root",
      kind: "result",
      correlationId: "parent-call",
      contentParts: [{ type: "text", text: "finished child work" }],
    }));
    expect(wakeup).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      targetRunId: "parent-run",
      targetAgentCallId: "parent-agent-call",
      targetThreadKey: "root",
      targetAgentName: "parent",
    }));
  });

  it("reconstructs a terminal mailbox result after a background owner lease expires", async () => {
    const child = childAgent();
    const delegationStore = store(child);
    const childRun = {
      run_id: "child-run",
      status: "running",
      agent_call_id: "child-call",
      parent_run_id: "parent-run",
      parent_call_id: "parent-call",
      thread_key: child.thread_key,
      child_agent_id: child.child_agent_id,
      agent_name: "worker",
    };
    const parentRun = {
      run_id: "parent-run",
      status: "completed",
      agent_call_id: "parent-agent-call",
      parent_run_id: null,
      parent_call_id: null,
      lineage_parent_call_id: null,
      lease_root_run_id: "parent-run",
      thread_key: "root",
      child_agent_id: null,
      agent_name: "parent",
    };
    vi.mocked(delegationStore.getRun).mockImplementation(async (_sessionId, runId) => {
      return (runId === "child-run" ? childRun : runId === "parent-run" ? parentRun : null) as never;
    });
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      kind: input.kind,
      correlation_id: input.correlationId,
      expires_at: null,
    })) as never;
    const wakeup = vi.fn();
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      { enqueue, get: vi.fn(), claim: vi.fn(), ack: vi.fn(), release: vi.fn(), expire: vi.fn() } as never,
      null,
      "tenant-1",
    );
    service.setMailboxWakeup(wakeup);

    await service.recoverBackgroundTask({
      task_id: "background-task",
      description: "worker",
      output_path: "",
      started_at: 1,
      status: "failed",
      return_code: 1,
      error: "owner lease expired",
      expires_at: null,
      run_id: "child-run",
      owner_task_id: null,
      session_id: "session-1",
      completed_at: 2,
      result_type: "agent_delegation_result",
      kind: "agent",
      cancel_supported: true,
    });

    expect(delegationStore.updateRunStatus).toHaveBeenCalledWith(
      "child-run",
      "session-1",
      "interrupted",
      null,
      "background_task_owner_lease_expired",
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "child-run:terminal_result",
      targetRunId: "parent-run",
      targetAgentCallId: "parent-agent-call",
      kind: "result",
      metadata: expect.objectContaining({ recovered: true, status: "failed" }),
    }));
    expect(wakeup).toHaveBeenCalledWith(expect.objectContaining({ targetRunId: "parent-run" }));
  });

  it("does not duplicate foreground results or publish suspended children", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-terminal-"));
    tempRoots.push(root);
    const mailbox = {
      enqueue: vi.fn(),
      get: vi.fn(),
      claim: vi.fn(),
      ack: vi.fn(),
      release: vi.fn(),
      expire: vi.fn(),
    };

    const suspendedTasks = new BackgroundTaskService();
    const suspendedService = new AgentDelegationService(
      store(childAgent()),
      runtimeCore(workerAgent()),
      null,
      suspendedTasks,
      root,
      mailbox as never,
    );
    suspendedService.setInvocationService(new AgentInvocationService({
      executeRun: vi.fn(async () => ({
        success: false,
        content: "waiting for input",
        suspended: true,
        interactionKind: "user_input" as const,
      })),
    } as never));
    const suspendedResult = await invokeCreate(suspendedService, {
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "ask user", runInBackground: true, callId: "parent-call" },
    }, context(new AbortController().signal));
    const suspendedTaskId = String((suspendedResult.content as Record<string, unknown>).background_task_id);
    await waitFor(() => suspendedTasks.getTaskSnapshot(suspendedTaskId)?.status === "completed");

    const foregroundService = new AgentDelegationService(
      store(childAgent()),
      runtimeCore(workerAgent()),
      null,
      null,
      null,
      mailbox as never,
    );
    foregroundService.setInvocationService(new AgentInvocationService({
      executeRun: vi.fn(async () => ({ success: true, content: "foreground result" })),
    } as never));
    const foregroundResult = await invokeCreate(foregroundService, {
      agent: parentAgent(false),
      teamName: null,
      input: { agentName: "worker", task: "do foreground work", callId: "parent-call" },
    }, context(new AbortController().signal));

    expect(suspendedResult.success).toBe(true);
    expect(foregroundResult.success).toBe(true);
    expect(mailbox.enqueue).not.toHaveBeenCalled();
  });

  it("publishes failed background outcomes with a stable idempotency key", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-failed-"));
    tempRoots.push(root);
    const backgroundTasks = new BackgroundTaskService();
    const delegationStore = store(childAgent());
    vi.mocked(delegationStore.getRun).mockResolvedValue({
      run_id: "parent-run",
      agent_call_id: "parent-agent-call",
      thread_key: "root",
      child_agent_id: null,
      agent_name: "parent",
    } as never);
    const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
      message_id: input.messageId,
      seq: 1,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      source_run_id: input.sourceRunId ?? null,
      source_agent_call_id: input.sourceAgentCallId ?? null,
      target_run_id: input.targetRunId ?? null,
      target_agent_call_id: input.targetAgentCallId ?? null,
      target_thread_key: input.targetThreadKey,
      target_child_agent_id: input.targetChildAgentId ?? null,
      kind: input.kind,
      correlation_id: input.correlationId ?? null,
      reply_to_message_id: null,
      content_parts: input.contentParts,
      metadata: input.metadata ?? {},
      status: "queued",
      attempt_count: 0,
      claim_id: null,
      claimed_by: null,
      claim_expires_at: null,
      available_at: new Date(0).toISOString(),
      expires_at: null,
      last_error: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      acked_at: null,
    })) as never;
    const service = new AgentDelegationService(
      delegationStore,
      runtimeCore(workerAgent()),
      null,
      backgroundTasks,
      root,
      { enqueue, get: vi.fn(), claim: vi.fn(), ack: vi.fn(), release: vi.fn(), expire: vi.fn() } as never,
    );
    service.setInvocationService(new AgentInvocationService({
      executeRun: vi.fn(async () => ({ success: false, content: "worker failed" })),
    } as never));

    const result = await invokeCreate(service, {
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "fail", runInBackground: true, callId: "parent-call" },
    }, context(new AbortController().signal));
    const taskId = String((result.content as Record<string, unknown>).background_task_id);
    await waitFor(() => backgroundTasks.getTaskSnapshot(taskId)?.status === "failed");

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      messageId: expect.stringContaining(":terminal_result"),
      targetRunId: "parent-run",
      targetAgentCallId: "parent-agent-call",
      kind: "result",
      metadata: expect.objectContaining({ status: "failed", success: false, visible_to_user: false }),
    }));
  });

  it("stores the inherited workspace without worktree metadata", () => {
    const metadata = buildChildMetadata({ workspaceRoot: "C:\\workspace" } as never, "child:worker", "agent");
    expect(metadata).toMatchObject({
      created_via: "agent",
      thread_key: "child:worker",
      workspace_root: "C:\\workspace",
    });
    expect(metadata).not.toHaveProperty("uses_worktree");
    expect(metadata).not.toHaveProperty("original_workspace_root");
  });

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

    const enabledCall = enabled.find((tool) => tool.name === "agent");
    const disabledCall = disabled.find((tool) => tool.name === "agent");
    expect(enabledCall?.parameters.properties).toHaveProperty("run_in_background");
    expect(disabledCall?.parameters.properties).not.toHaveProperty("run_in_background");
    expect(disabledCall?.parameters.properties).not.toHaveProperty("runInBackground");
  });

  it("routes the unified agent tool by target shape", async () => {
    const service = new AgentDelegationService({} as never, {} as never);
    const createChild = vi.spyOn(service as any, "createChild").mockResolvedValue({
      success: true,
      toolName: "agent",
    } as never);
    const deliverMessage = vi.spyOn(service as any, "deliverMessage").mockResolvedValue({
      success: true,
      toolName: "agent",
    } as never);
    const parent = parentAgent(false);
    const runContext = context(new AbortController().signal);

    const created = await service.agent({
      agent: parent,
      teamName: null,
      input: { agentName: "worker", message: "inspect this", timeoutMs: 1234, callId: "tool-create" },
    }, runContext);
    expect(created.toolName).toBe("agent");
    expect(createChild).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ agentName: "worker", task: "inspect this", timeoutMs: 1234 }),
    }), runContext);

    const existing = await service.agent({
      agent: parent,
      teamName: null,
      input: { childAgentId: "child-worker", message: "continue", callId: "tool-followup" },
    }, runContext);
    expect(existing.toolName).toBe("agent");
    expect(deliverMessage).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ childAgentId: "child-worker", message: "continue", toParent: false }),
    }), runContext);

    const childContext = { ...runContext, parentRunId: "parent-run", currentChildAgentId: "child-worker" };
    await service.agent({
      agent: workerAgent(),
      teamName: null,
      input: { message: "progress", callId: "tool-parent" },
    }, childContext);
    expect(deliverMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      input: expect.objectContaining({ message: "progress", toParent: true }),
    }), childContext);

    const rootWithoutTarget = await service.agent({
      agent: parent,
      teamName: null,
      input: { message: "missing target", callId: "tool-root-error" },
    }, runContext);
    expect(rootWithoutTarget.success).toBe(false);
    expect(rootWithoutTarget.content).toContain("需要 agent_name");
  });

  it("rejects an ambiguous request that includes both child targets", async () => {
    const service = new AgentDelegationService({} as never, {} as never);
    const result = await service.agent({
      agent: parentAgent(false),
      teamName: null,
      input: {
        agentName: "worker",
        childAgentId: "child-worker",
        message: "ambiguous",
      },
    }, context(new AbortController().signal));
    expect(result.success).toBe(false);
    expect(result.content).toContain("不能同时指定");
  });

  it("exposes the parent mailbox route for child invocations without child allowlist", () => {
    const tools = createDelegationTools({
      agent: workerAgent(),
      teamName: null,
      getAgentDelegation: () => ({} as DelegationPort),
      canMessageParent: true,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["agent"]);
    expect(tools[0]?.parameters.properties).toHaveProperty("child_agent_id");
  });

  it("keeps delegation policy concise and puts candidate details in the function schema", () => {
    const delegation = {} as DelegationPort;
    const tools = createDelegationTools({
      agent: parentAgent(false),
      teamName: null,
      getAgentDelegation: () => delegation,
      agentConfig: { getConfig: () => ({ ...workerAgent(), description: "Processes focused research tasks." }) },
    });
    const agentTool = tools.find((tool) => tool.name === "agent");
    const properties = agentTool?.parameters.properties as Record<string, Record<string, unknown>> | undefined;
    const agentName = properties?.agent_name;
    const prompt = buildFullSystemPrompt(
      { behavior: { systemPrompt: "" } } as Parameters<typeof buildFullSystemPrompt>[0],
      { tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        allowed_callers: tool.allowedCallers,
        ...(tool.extendedUsage ? { extended_usage: tool.extendedUsage } : {}),
      })) },
      "native",
    );

    expect(agentName?.enum).toEqual(["worker"]);
    expect(agentName?.description).toContain("worker (Worker): Processes focused research tasks.");
    expect(agentTool?.extendedUsage).toContain("优先复用已有 child_agent_id");
    expect(agentTool?.examples).toBeUndefined();
    expect(prompt).not.toContain("优先顺序：直答 > direct tool > 单子 Agent > 多 Agent");
    expect(prompt).not.toContain("background_task_id");
    expect(prompt).not.toContain("可委派子 Agent：");
    expect(prompt).not.toContain("**调用能力**");
  });

  it("returns separate background/task/run ids and does not inherit the parent abort signal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ragsystem-delegation-"));
    tempRoots.push(root);
    const backgroundTasks = new BackgroundTaskService();
    const worker = workerAgent();
    const child = childAgent();
    let finishRun!: () => void;
    const executeRun = vi.fn(({ abortController }: { abortController: AbortController; ownsRunLease?: boolean; timeoutMs?: number }) => new Promise<{ success: boolean; content: string }>((resolve) => {
      finishRun = () => resolve({ success: true, content: "worker result" });
      abortController.signal.addEventListener("abort", () => resolve({ success: false, content: "aborted" }), { once: true });
    }));
    const runEngine = { executeRun } as never;
    const service = new AgentDelegationService(store(child), runtimeCore(worker), null, backgroundTasks, root);
    service.setInvocationService(new AgentInvocationService(runEngine));
    const parentAbort = new AbortController();

    const result = await invokeCreate(service, {
      agent: parentAgent(true),
      teamName: null,
      input: { agentName: "worker", task: "do work", timeoutMs: 4321, runInBackground: true, callId: "parent-call" },
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
    expect(executeRun.mock.calls[0]?.[0].timeoutMs).toBe(4321);
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
    service.setInvocationService(new AgentInvocationService({ executeRun } as never));

    const result = await invokeCreate(service, {
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
    service.setInvocationService(new AgentInvocationService({ executeRun } as never));

    const result = await invokeCreate(service, {
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
      invocationService: new AgentInvocationService({ executeRun } as never),
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
      executionKind: "agent",
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

type AgentTestContext = Parameters<AgentDelegationService["agent"]>[1];

function invokeCreate(
  service: AgentDelegationService,
  call: AgentDelegationCall,
  ctx: AgentTestContext,
) {
  return service.agent({
    agent: call.agent,
    teamName: call.teamName,
    input: {
      agentName: call.input.agentName,
      message: call.input.task,
      contextHint: call.input.contextHint,
      timeoutMs: call.input.timeoutMs,
      runInBackground: call.input.runInBackground,
      callId: call.input.callId,
    },
  }, ctx);
}

function invokeMessage(
  service: AgentDelegationService,
  call: SendMessageCall,
  ctx: AgentTestContext,
) {
  return service.agent({
    agent: call.agent,
    teamName: call.teamName,
    input: {
      ...(call.input.childAgentId ? { childAgentId: call.input.childAgentId } : {}),
      message: call.input.message,
      kind: call.input.kind,
      correlationId: call.input.correlationId,
      replyToMessageId: call.input.replyToMessageId,
      timeoutMs: call.input.timeoutMs,
      runInBackground: call.input.runInBackground,
      callId: call.input.callId,
    },
  }, ctx);
}
