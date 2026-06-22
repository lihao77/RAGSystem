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
  it("expands assistant execution steps and compacts raw fields like Python", async () => {
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
            execution_steps: [
              {
                kind: "tool",
                result_preview: "short result",
              },
            ],
          },
        ],
      },
    });
    expect(messages.json().data.items[0].execution_steps[0]).not.toHaveProperty("raw_result");
    expect(messages.json().data.items[0].execution_steps[0]).not.toHaveProperty("result");

    const runSteps = await app.inject({
      method: "GET",
      url: `/api/agent/sessions/s1/messages/${assistant.id}/run-steps`,
    });

    expect(runSteps.statusCode).toBe(200);
    expect(runSteps.json()).toMatchObject({
      success: true,
      data: {
        message_id: assistant.id,
        total: 1,
        items: [
          {
            kind: "tool",
            result_preview: "short result",
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
    // run 树聚合:root 的 subtask step + child 的 tool step 都返回(root 先,子孙后)。
    expect(result.items.map((s) => (s as { kind: string }).kind)).toEqual(["subtask", "tool"]);
    expect(result.items.map((s) => (s as { tool_name?: string }).tool_name)).toContain("execute_bash");
  });
});
