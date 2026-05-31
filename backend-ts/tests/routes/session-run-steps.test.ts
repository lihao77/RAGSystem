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
});
