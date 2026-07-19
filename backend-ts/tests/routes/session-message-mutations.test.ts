import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { buildTestHarness } from "../helpers/app.js";
import { PathApprovalService } from "../../src/adapters/local/path-approval-service.js";
import { toolContext } from "../helpers/tool-context.js";
import { mockLlm } from "../helpers/llm-fetch-mock.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { SaaSSessionApplication } from "../../src/application/session/saas-session-application.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
    app = null;
  }
});

describe("session message mutation routes", () => {
  it("routes message update and rollback through the SaaS conversation repository", async () => {
    const session = {
      session_id: "saas-session",
      tenant_id: LOCAL_TENANT_ID,
      user_id: "usr_local",
      permission_mode: null,
      metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const repository = {
      getSession: vi.fn().mockResolvedValue(session),
      updateMessage: vi.fn().mockResolvedValue(true),
      deleteMessagesAfter: vi.fn().mockResolvedValue(3),
    };
    const saas = new SaaSSessionApplication(LOCAL_TENANT_ID, repository as never);
    const harness = await buildTestHarness({ resolveSessionApplication: () => saas });
    app = harness.app;

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/agent/sessions/saas-session/messages/message-1",
      payload: { content: "new task" },
    });
    const rolledBack = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/saas-session/rollback",
      payload: { after_message_id: "message-1" },
    });

    expect(updated.statusCode).toBe(200);
    expect(rolledBack.json()).toMatchObject({ success: true, data: { deleted: 3 } });
    expect(repository.updateMessage).toHaveBeenCalledWith({ sessionId: "saas-session", messageId: "message-1", content: "new task", roleFilter: "user" });
    expect(repository.deleteMessagesAfter).toHaveBeenCalledWith("saas-session", { afterSeq: null, afterMessageId: "message-1" });
    expect(harness.container.sessionApplication.getSession("saas-session")).toBeNull();
  });

  it("updates only editable user messages", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "s1" });
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

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "s1" });
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
      stepType: "protocol.envelope.v1",
      payload: { type: "tool_call", session_id: "s1", run_id: "run-1", payload: { tool: "read_file", phase: "start" } },
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
    const llm = mockLlm({ contents: ["retried answer"] });
    const harness = await buildTestHarness();
    app = harness.app;
    await createDefaultChatProvider(app);

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local", sessionId: "retry-session" });
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

    expect(llm.requests).toHaveLength(1);
    expect(((llm.requests[0]?.body?.messages ?? []).at(-1) as { content?: string } | undefined)?.content).toContain("new task");
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

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID, userId: "usr_local",
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
      toolContext({
        sessionId: "file-rollback-session",
        workspaceRoot,
      }),
      rollbackAgent(workspaceRoot),
      new PathApprovalService(),
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
      toolContext({
        sessionId: "file-rollback-session",
        workspaceRoot,
      }),
      rollbackAgent(workspaceRoot),
      new PathApprovalService(),
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

  it("exports session JSON with visible messages and protocol execution events", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ tenantId: LOCAL_TENANT_ID,
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
    harness.container.clientEvents.publish("session export!", {
      type: "stream_output",
      session_id: "session export!",
      run_id: "run-1",
      payload: { phase: "final", content: "done" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/session%20export!/export",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="session_session_export.json"');
    expect(JSON.parse(response.body)).toMatchObject({
      version: 2,
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
          execution_events: [
            { type: "stream_output", payload: { phase: "final", content: "done" } },
          ],
        },
      ],
    });
  });
});

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

function rollbackAgent(workspaceRoot: string): AgentConfig {
  return {
    agent_name: "rollback_agent",
    enabled: true,
    default_entry: false,
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: { auto_inject: true, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: { workspace_root: workspaceRoot },
  };
}
