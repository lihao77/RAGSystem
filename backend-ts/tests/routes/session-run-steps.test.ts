import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("session run step routes", () => {
  it("keeps message payloads lean and returns protocol envelopes from the run-steps sidecar", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "s1" });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      metadata: { run_id: "run-1" },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "start",
        call_id: "tool-1",
        parent_call_id: "root-call",
        agent_name: "orchestrator_agent",
        tool_name: "read_file",
        arguments: { file_path: "README.md" },
        result: "full result",
        result_preview: "short result",
        raw_result: "raw",
        event_id: "event-1",
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
  });

  it("aggregates child agent run steps into the message run tree", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "s2" });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "s2",
      role: "assistant",
      content: "delegated answer",
      metadata: { run_id: "root-run" },
    });
    // root run(final message = assistant):记录 subtask step(子 agent 容器节点)。
    harness.container.conversationStore.createRun({
      runId: "root-run",
      sessionId: "s2",
      status: "running",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    harness.container.conversationStore.updateRunStatus("root-run", "s2", "completed", assistant.id);
    harness.container.conversationStore.addRunStep({
      sessionId: "s2",
      runId: "root-run",
      stepType: "execution.step",
      payload: {
        kind: "subtask",
        phase: "start",
        call_id: "agent-call-1",
        parent_call_id: "root-call",
        round: 0,
        agent_name: "general_agent",
      },
    });
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
    harness.container.conversationStore.addRunStep({
      sessionId: "s2",
      runId: "child-run",
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "start",
        call_id: "tool-1",
        parent_call_id: "agent-call-1",
        tool_name: "execute_bash",
        round: 0,
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
});
