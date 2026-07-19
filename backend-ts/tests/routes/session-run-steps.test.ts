import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildExecutionTree, type Envelope } from "@ragsystem/agent-protocol";

import { buildTestHarness } from "../helpers/app.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("session run step routes", () => {
  it("uses the SaaS application for PG-only sessions", async () => {
    const saas = {
      getSession: vi.fn().mockResolvedValue({
        session_id: "saas-session",
        tenant_id: LOCAL_TENANT_ID,
        user_id: "usr_local",
        permission_mode: null,
        metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
      listMessageRunSteps: vi.fn().mockResolvedValue({
        message_id: "assistant-message",
        items: [],
        total: 0,
        limit: 500,
        offset: 0,
        has_more: false,
      }),
    };
    const harness = await buildTestHarness({ resolveSessionApplication: () => saas as never });
    app = harness.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/saas-session/messages/assistant-message/run-steps",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ message_id: "assistant-message", items: [] });
    expect(saas.listMessageRunSteps).toHaveBeenCalledWith({
      sessionId: "saas-session",
      messageId: "assistant-message",
      limit: 500,
      offset: 0,
    });
  });

  it("keeps message payloads lean and returns protocol envelopes from the run-steps sidecar", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "s1" });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      metadata: { run_id: "run-1" },
    });
    harness.container.clientEvents.publish("s1", {
      type: "agent_started",
      session_id: "s1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "orchestrator_agent",
      payload: { phase: "start" },
    });
    harness.container.clientEvents.publish("s1", {
      type: "tool_call",
      session_id: "s1",
      run_id: "run-1",
      call_id: "tool-1",
      agent_id: "orchestrator_agent",
      payload: {
        tool: "read_file",
        input: { file_path: "README.md" },
        phase: "start",
        lineage: { parent_call_id: "root-call" },
      },
    });
    harness.container.conversationStore.updateRunStepsMessageId("s1", "run-1", assistant.id);

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/messages?expand=true",
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toMatchObject({
      success: true,
      data: {
        items: [
          {
            id: assistant.id,
            has_execution: true,
          },
        ],
      },
    });
    expect(messages.json().data.items[0]).not.toHaveProperty("execution_steps");

    const runSteps = await app.inject({
      method: "GET",
      url: `/api/agent/sessions/s1/messages/${assistant.id}/run-steps`,
    });

    expect(runSteps.statusCode).toBe(200);
    expect(runSteps.json()).toMatchObject({
      success: true,
      data: {
        message_id: assistant.id,
        total: 2,
        items: [
          {
            type: "agent_started",
            call_id: "root-call",
          },
          {
            type: "tool_call",
            call_id: "tool-1",
            payload: {
              tool: "read_file",
              input: { file_path: "README.md" },
              lineage: { parent_call_id: "root-call" },
            },
          },
        ],
      },
    });
    const archived = harness.container.conversationStore
      .listRunSteps({ sessionId: "s1", runId: "run-1", limit: 100 })
      .filter((step) => step.step_type === "protocol.envelope.v1");
    expect(archived).toHaveLength(2);
    expect(archived.every((step) => step.payload.protocol_version === "1.0")).toBe(true);

    const replayed = harness.container.sessionApplication.listMessageRunSteps({
      sessionId: "s1",
      messageId: assistant.id,
    });
    expect(replayed.items).toEqual(runSteps.json().data.items);
  });

  it("aggregates child agent run steps into the message run tree", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "s2" });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "s2",
      role: "assistant",
      content: "delegated answer",
      metadata: { run_id: "root-run" },
    });
    // root run(final message = assistant)。
    harness.container.conversationStore.createRun({
      runId: "root-run",
      sessionId: "s2",
      status: "running",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    harness.container.conversationStore.updateRunStatus("root-run", "s2", "completed", assistant.id);
    // child run(parent_run_id=root-run):其工具 step 落子 run_id 下。
    harness.container.conversationStore.createRun({
      runId: "child-run",
      sessionId: "s2",
      status: "running",
      agentName: "general_agent",
      threadKey: "child:child-1",
      parentRunId: "root-run",
      parentCallId: "agent-call-1",
      childAgentId: "child-1",
    });
    harness.container.clientEvents.publish("s2", {
      type: "agent_started",
      session_id: "s2",
      run_id: "root-run",
      call_id: "root-call",
      agent_id: "orchestrator_agent",
      payload: { phase: "start" },
    });
    harness.container.clientEvents.publish("s2", {
      type: "agent_started",
      session_id: "s2",
      run_id: "root-run",
      call_id: "agent-call-1",
      agent_id: "general_agent",
      payload: {
        phase: "start",
        invocation_call_id: "delegate-call",
        lineage: { parent_call_id: "root-call" },
      },
    });
    harness.container.clientEvents.publish("s2", {
      type: "tool_call",
      session_id: "s2",
      run_id: "child-run",
      call_id: "tool-1",
      agent_id: "general_agent",
      payload: {
        tool: "execute_bash",
        phase: "start",
        round: 0,
        lineage: { parent_call_id: "agent-call-1" },
      },
    });

    const result = harness.container.sessionApplication.listMessageRunSteps({
      sessionId: "s2",
      messageId: assistant.id,
    });
    // run 树聚合后直接返回 Envelope；子 agent 工具仍归属 agent-call-1。
    expect(result.items.map((event) => event.type)).toEqual(["agent_started", "agent_started", "tool_call"]);
    expect(result.items.at(-1)).toMatchObject({
      type: "tool_call",
      call_id: "tool-1",
      payload: {
        tool: "execute_bash",
        lineage: { parent_call_id: "agent-call-1" },
      },
    });
  });

  it("replays the same execution tree from archived envelopes after outbox cleanup", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    const sessionId = "s3";
    const rootRunId = "root-run";
    const childRunId = "child-run";
    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId });
    harness.container.conversationStore.createRun({
      runId: rootRunId,
      sessionId,
      status: "running",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    harness.container.conversationStore.createRun({
      runId: childRunId,
      sessionId,
      status: "running",
      agentName: "worker_agent",
      threadKey: "child:worker-1",
      parentRunId: rootRunId,
      parentCallId: "child-call",
      childAgentId: "worker-1",
    });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId,
      role: "assistant",
      content: "done",
      metadata: { run_id: rootRunId },
    });

    const liveEvents: Envelope[] = [
      envelope("agent_started", rootRunId, "root-call", "orchestrator_agent", {
        phase: "start",
        display_name: "Orchestrator",
      }),
      envelope("stream_output", rootRunId, "root-call", "orchestrator_agent", {
        phase: "intent_complete",
        content: "delegate",
        round: 0,
      }),
      envelope("tool_call", rootRunId, "delegate-call", "orchestrator_agent", {
        tool: "call_agent",
        input: { agent_name: "worker_agent" },
        phase: "start",
        round: 0,
        lineage: { parent_call_id: "root-call" },
      }),
      envelope("agent_started", rootRunId, "child-call", "worker_agent", {
        phase: "start",
        display_name: "Worker",
        invocation_call_id: "delegate-call",
        lineage: { parent_call_id: "root-call" },
      }),
      envelope("tool_call", childRunId, "child-tool", "worker_agent", {
        tool: "read_file",
        input: { path: "README.md" },
        phase: "start",
        round: 0,
        lineage: { parent_call_id: "child-call" },
      }),
      envelope("tool_result", childRunId, "child-tool", "worker_agent", {
        tool: "read_file",
        phase: "end",
        ok: true,
        observation: "content",
        lineage: { parent_call_id: "child-call" },
      }),
      envelope("agent_ended", rootRunId, "child-call", "worker_agent", {
        phase: "end",
        result: "content",
        success: true,
        invocation_call_id: "delegate-call",
        lineage: { parent_call_id: "root-call" },
      }),
    ];
    for (const event of liveEvents) {
      harness.container.clientEvents.publish(sessionId, event, { runId: event.run_id });
    }

    const deleted = harness.container.conversationStore.deleteDeliveredOutbox({
      before: new Date(Date.now() + 60_000).toISOString(),
      limit: 100,
    });
    expect(deleted).toBe(liveEvents.length);
    expect(harness.container.conversationStore.listOutboxForReplay({ sessionId })).toEqual([]);

    const history = harness.container.sessionApplication.listMessageRunSteps({
      sessionId,
      messageId: assistant.id,
    });
    expect(history.items).toHaveLength(liveEvents.length);
    expect(history.items.every((event) => event.protocol_version === "1.0")).toBe(true);
    expect(buildExecutionTree(history.items).root).toEqual(buildExecutionTree(liveEvents).root);
  });
});

function envelope(
  type: Envelope["type"],
  runId: string,
  callId: string,
  agentId: string,
  payload: Record<string, unknown>,
): Envelope {
  return {
    type,
    session_id: "s3",
    run_id: runId,
    call_id: callId,
    agent_id: agentId,
    payload,
  };
}
