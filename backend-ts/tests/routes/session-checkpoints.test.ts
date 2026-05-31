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

describe("session checkpoint routes", () => {
  it("lists checkpoints with Python-compatible response shape", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "qa_agent",
      round: 1,
      messages: [{ role: "user", content: "first" }],
    });
    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "qa_agent",
      round: 2,
      messages: [{ role: "user", content: "second" }],
    });
    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "other_agent",
      round: 3,
      messages: [{ role: "user", content: "other" }],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/checkpoints?agent_name=qa_agent&limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      message: "获取检查点列表成功",
      data: {
        checkpoints: [
          {
            checkpoint_id: "s1_qa_agent_r2",
            session_id: "s1",
            agent_name: "qa_agent",
            round: 2,
          },
        ],
      },
    });
  });

  it("keeps checkpoint recovery explicit until execution migration exists", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/s1/recover",
      payload: { checkpoint_id: "cp-1" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });
  });
});
