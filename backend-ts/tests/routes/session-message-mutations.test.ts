import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatCompletionRequest, ChatCompletionResult, LlmChatClient } from "../../src/services/integrations/llm-chat-client.js";
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

  it("rolls back to a user message, optionally edits it, and starts retry execution", async () => {
    const chatClient = new FakeChatClient("retried answer");
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;
    await createDefaultChatProvider(app);

    harness.container.sessionApplication.createSession({ sessionId: "retry-session" });
    const anchor = harness.container.sessionApplication.addMessage({
      sessionId: "retry-session",
      role: "user",
      content: "old task",
    });
    harness.container.sessionApplication.addMessage({
      sessionId: "retry-session",
      role: "assistant",
      content: "old answer",
      metadata: { run_id: "old-run" },
    });
    harness.container.sessionApplication.addMessage({
      sessionId: "retry-session",
      role: "user",
      content: "follow-up to delete",
    });

    const retry = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/retry-session/rollback-and-retry",
      headers: { "x-request-id": "req-retry-1" },
      payload: {
        after_seq: anchor.seq,
        modify_user_message: "new task",
      },
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      success: true,
      message: "重试已启动",
      data: {
        started: true,
        deleted: 2,
        request_id: "req-retry-1",
        kind: "agent_run",
        status: "started",
        success: true,
      },
    });

    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("retry-session").task_info?.status === "completed");

    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]?.messages.at(-1)?.content).toContain("new task");
    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/retry-session/messages?expand=1",
    });
    expect(messages.json().data.items).toEqual([
      expect.objectContaining({
        id: anchor.id,
        role: "user",
        content: "new task",
        metadata: expect.objectContaining({
          retry_modified_at: expect.any(String),
        }),
      }),
      expect.objectContaining({
        role: "assistant",
        content: "retried answer",
        has_execution: true,
        metadata: expect.objectContaining({
          execution_kind: "rollback_and_retry",
          retry_of_seq: anchor.seq,
          retry_of_message_id: anchor.id,
        }),
      }),
    ]);
  });

  it("restores file history snapshots when rolling back a session", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-rollback-workspace-"));
    const filePath = path.join(workspaceRoot, "notes.txt");

    harness.container.sessionApplication.createSession({
      sessionId: "file-rollback-session",
      metadata: { workspace_root: workspaceRoot },
    });
    const firstUser = harness.container.sessionApplication.addMessage({
      sessionId: "file-rollback-session",
      role: "user",
      content: "create file",
    });
    const firstWrite = harness.container.documentTools.writeFile(
      {
        filePath: "notes.txt",
        content: "v1",
      },
      {
        agent: null,
        sessionId: "file-rollback-session",
        workspaceRoot,
      },
    );
    expect(firstWrite).toMatchObject({ success: true });
    const secondUser = harness.container.sessionApplication.addMessage({
      sessionId: "file-rollback-session",
      role: "user",
      content: "snapshot v1",
    });
    expect(secondUser.metadata.snapshot_id).toEqual(expect.any(String));

    const secondWrite = harness.container.documentTools.writeFile(
      {
        filePath: "notes.txt",
        content: "v2",
      },
      {
        agent: null,
        sessionId: "file-rollback-session",
        workspaceRoot,
      },
    );
    expect(secondWrite).toMatchObject({ success: true });
    harness.container.sessionApplication.addMessage({
      sessionId: "file-rollback-session",
      role: "user",
      content: "snapshot v2",
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe("v2");

    const rollback = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/file-rollback-session/rollback",
      payload: { after_seq: secondUser.seq },
    });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({
      success: true,
      data: { deleted: 1 },
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe("v1");

    const rollbackToStart = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/file-rollback-session/rollback",
      payload: { after_seq: firstUser.seq },
    });
    expect(rollbackToStart.statusCode).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);
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

class FakeChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly content: string) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.requests.push(request);
    return { content: this.content };
  }
}

async function createDefaultChatProvider(app: FastifyInstance): Promise<void> {
  const provider = await app.inject({
    method: "POST",
    url: "/api/model-adapter/providers",
    payload: {
      name: "my",
      provider_type: "deepseek",
      api_key: "sk-test",
      model_map: {
        chat: "deepseek-chat",
      },
    },
  });
  expect(provider.statusCode).toBe(200);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
