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

describe("session message mutation routes", () => {
  it("updates only editable user messages", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "s1" });
    const user = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "user",
      content: "old task",
    });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "answer",
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agent/sessions/s1/messages/${user.id}`,
      payload: { content: "new task" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      success: true,
      message: "更新成功",
      data: { message_id: user.id },
    });

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/agent/sessions/s1/messages/${assistant.id}`,
      payload: { content: "bad edit" },
    });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toMatchObject({
      success: false,
      code: "not_found",
      message: "消息不存在或不可编辑",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/messages",
    });
    expect(messages.json().data.items.map((item: { content: string }) => item.content)).toEqual([
      "new task",
      "answer",
    ]);
  });

  it("rolls back after an anchor and requires an anchor like Python", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "s1" });
    const anchor = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "user",
      content: "keep",
    });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "delete",
      metadata: { run_id: "run-1" },
    });
    harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "user",
      content: "delete too",
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      messageId: assistant.id,
      stepType: "execution.step",
      payload: { kind: "tool" },
    });

    const missingAnchor = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/s1/rollback",
      payload: {},
    });
    expect(missingAnchor.statusCode).toBe(400);
    expect(missingAnchor.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "请提供 after_seq 或 after_message_id",
    });

    const rollback = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/s1/rollback",
      payload: { after_message_id: anchor.id },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({
      success: true,
      message: "回退成功",
      data: { deleted: 2 },
    });
    expect(harness.container.conversationStore.listRunSteps({ messageId: assistant.id, sessionId: "s1" })).toEqual([]);

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/messages",
    });
    expect(messages.json().data.items.map((item: { content: string }) => item.content)).toEqual(["keep"]);
  });

  it("exports session JSON with visible messages and expanded steps", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({
      sessionId: "session export!",
      userId: "u1",
      metadata: { title: "Exported session" },
    });
    harness.container.sessionApplication.addMessage({
      sessionId: "session export!",
      role: "user",
      content: "task",
    });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "session export!",
      role: "assistant",
      content: "answer",
      metadata: { run_id: "run-1" },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "session export!",
      runId: "run-1",
      messageId: assistant.id,
      stepType: "execution.step",
      payload: { kind: "final", result: "done" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/session%20export!/export",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="session_session_export.json"');
    expect(JSON.parse(response.body)).toMatchObject({
      version: 1,
      session: {
        session_id: "session export!",
        user_id: "u1",
      },
      message_count: 2,
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: "answer",
          has_execution: true,
          execution_steps: [{ kind: "final", result: "done" }],
        },
      ],
    });
  });
});
