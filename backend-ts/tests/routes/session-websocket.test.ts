import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestHarness } from "../helpers/app.js";
import { mockLlm } from "../helpers/llm-fetch-mock.js";
import { getRealtimeHistory } from "../helpers/realtime.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
    app = null;
  }
});

describe("session websocket route", () => {
  it("requires a one-time ticket in password mode and rejects a session JWT query", async () => {
    const harness = await buildTestHarness({ sessionJwtSecret: "ws-ticket-secret-0123456789abcdef0123456789" });
    app = harness.app;
    await app.inject({
      method: "POST",
      url: "/api/install",
      payload: { deployment: "saas", admin: { username: "admin", password: "password123" } },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "password123" },
    });
    const token = login.json().token as string;
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/agent/sessions",
      headers,
      payload: { session_id: "password-ws-ticket" },
    });
    expect(created.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/password-ws-ticket/ws-ticket",
      headers,
    });
    expect(issued.statusCode).toBe(200);
    const ticket = issued.json().data.ticket as string;

    const client = await connectWs(app, `/api/agent/sessions/password-ws-ticket/ws?ticket=${encodeURIComponent(ticket)}`);
    client.ws.terminate();
    await expect(app.injectWS(`/api/agent/sessions/password-ws-ticket/ws?session_token=${encodeURIComponent(token)}`)).rejects.toThrow();
  });

  it("accepts an issued ticket once and rejects replay", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    const created = await app.inject({
      method: "POST",
      url: "/api/agent/sessions",
      payload: { session_id: "ws-ticket-session" },
    });
    expect(created.statusCode).toBe(200);
    const issued = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/ws-ticket-session/ws-ticket",
    });
    expect(issued.statusCode).toBe(200);
    const ticket = issued.json().data.ticket as string;
    const path = `/api/agent/sessions/ws-ticket-session/ws?ticket=${encodeURIComponent(ticket)}`;

    const client = await connectWs(app, path);
    client.ws.terminate();
    await expect(app.injectWS(path)).rejects.toThrow();
  });

  it("does not send an empty reconnect envelope for idle sessions", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    const client = await connectWs(app, "/api/agent/sessions/idle-session/ws");
    try {
      const firstMessage = await client.receiveJson(60);

      expect(firstMessage).toBeNull();
    } finally {
      client.ws.terminate();
    }
  });

  it("replays only the current active run history with monotonic seq", async () => {
    const llm = mockLlm({ contents: ["held answer"] });
    llm.hold();
    const harness = await buildTestHarness();
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.localInfrastructure.conversationStore.createSession(LOCAL_TENANT_ID, "ws-active-session", "usr_local");
    // 手动注入一条旧 run 的 stream_output：不属于当前 active run 树，重放时应被排除。
    harness.container.clientEvents.publish("ws-active-session", {
      type: "stream_output",
      session_id: "ws-active-session",
      run_id: "old-run",
      payload: { phase: "delta", content: "old" },
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "hold this run",
        session_id: "ws-active-session",
      },
    });
    expect(started.statusCode).toBe(200);
    const runId = started.json().data.run_id;
    expect(runId).toEqual(expect.any(String));

    await waitFor(() => llm.requests.length === 1);
    // 手动注入一条当前 run 的 stale approval(interaction, required)：未在 pendingInteractions
    // 注册表里，重放过滤（isPendingInteractionReplayEvent）会排除，避免前端重复弹窗。
    harness.container.clientEvents.publish("ws-active-session", {
      type: "interaction",
      session_id: "ws-active-session",
      run_id: runId,
      call_id: "stale-approval",
      payload: { kind: "approval", phase: "required", tool: "execute_bash" },
    });

    const client = await connectWs(app, "/api/agent/sessions/ws-active-session/ws");
    try {
      const reconnectStart = await client.receiveJson();
      expect(reconnectStart).toMatchObject({
        type: "session.reconnect",
        session_id: "ws-active-session",
        run_id: runId,
        payload: { phase: "start" },
      });
      expect((reconnectStart?.payload as { replay_count?: number }).replay_count).toBeGreaterThan(0);

      const replayed = [];
      for (let index = 0; index < Number((reconnectStart?.payload as { replay_count?: number }).replay_count ?? 0); index += 1) {
        replayed.push(await client.receiveJson());
      }
      const reconnectEnd = await client.receiveJson();

      expect(reconnectEnd).toMatchObject({
        type: "session.reconnect",
        session_id: "ws-active-session",
        payload: { phase: "end" },
      });
      // 重放仅含当前 active run 的事件；旧 run chunk 与 stale approval 都被排除。
      expect(replayed.every((event) => event?.run_id === runId)).toBe(true);
      expect(replayed.some((event) => event?.type === "run_started")).toBe(true);
      expect(replayed.some((event) => event?.run_id === "old-run")).toBe(false);
      expect(
        replayed.some((event) => event?.type === "interaction" && event?.call_id === "stale-approval"),
      ).toBe(false);
      // 重放事件 envelope seq 严格单调递增（reconnect 控制帧不经 outbox、不带 seq，不参与序号）。
      const replayedSeqs = replayed.map((event) => event?.seq);
      expect(replayedSeqs).toEqual([...replayedSeqs].sort((left, right) => Number(left) - Number(right)));
      expect(new Set(replayedSeqs).size).toBe(replayedSeqs.length);
    } finally {
      client.ws.terminate();
      await harness.container.agentExecution.stopSession("ws-active-session");
      llm.release();
    }
  });

  it("sends a run_started envelope and reconnect frames when a connected session starts a run", async () => {
    const llm = mockLlm({ contents: ["held answer"] });
    llm.hold();
    const harness = await buildTestHarness();
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.localInfrastructure.conversationStore.createSession(LOCAL_TENANT_ID, "ws-live-bind-session", "usr_local");
    const client = await connectWs(app, "/api/agent/sessions/ws-live-bind-session/ws");
    try {
      const started = await app.inject({
        method: "POST",
        url: "/api/agent/stream",
        payload: {
          task: "hold live binding",
          session_id: "ws-live-bind-session",
        },
      });
      expect(started.statusCode).toBe(200);
      const runId = started.json().data.run_id;
      expect(runId).toEqual(expect.any(String));

      const runStarted = await client.receiveJson();
      const reconnectStart = await client.receiveJson();
      const reconnectEnd = await client.receiveJson();

      expect(runStarted).toMatchObject({
        type: "run_started",
        session_id: "ws-live-bind-session",
        run_id: runId,
        seq: 1,
      });
      // reconnect 控制帧不经 outbox，不带 seq（envelope seq 只属于真实事件）。
      expect(reconnectStart).toMatchObject({
        type: "session.reconnect",
        session_id: "ws-live-bind-session",
        run_id: runId,
        payload: { phase: "start", replay_count: 0 },
      });
      expect(reconnectStart?.seq).toBeUndefined();
      expect(reconnectEnd).toMatchObject({
        type: "session.reconnect",
        session_id: "ws-live-bind-session",
        payload: { phase: "end" },
      });
      expect(reconnectEnd?.seq).toBeUndefined();

      const next = await client.receiveJson();
      expect(next?.seq).toBe(2);
      expect(next?.run_id).toBe(runId);
    } finally {
      client.ws.terminate();
      await harness.container.agentExecution.stopSession("ws-live-bind-session");
      llm.release();
    }
  });

  it("responds to approval messages with an ack and resolves the pending approval", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.localInfrastructure.conversationStore.createSession(LOCAL_TENANT_ID, "ws-approval-session", "usr_local");
    harness.localInfrastructure.conversationStore.createRun({ runId: "run-approval", sessionId: "ws-approval-session", agentName: "orchestrator_agent" });

    const approvalPromise = harness.container.pendingInteractions.waitForApproval({
      sessionId: "ws-approval-session",
      runId: "run-approval",
      rootRunId: "run-approval",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-call-approval",
      deadlineMs: 120_000,
      task: "执行命令",
      toolName: "execute_bash",
      description: "Run command",
    });
    await vi.waitFor(() => expect(getRealtimeHistory(harness.container.realtimeEvents, "ws-approval-session")
      .find((event) => event.type === "interaction")).toBeDefined());
    const approvalRequired = getRealtimeHistory(harness.container.realtimeEvents, "ws-approval-session")
      .find(
        (event) =>
          event.type === "interaction" &&
          (event.payload as { kind?: string; phase?: string }).kind === "approval" &&
          (event.payload as { phase?: string }).phase === "required",
      );
    const approvalId = approvalRequired?.call_id as string;
    expect(approvalId).toBeTruthy();

    const client = await connectWs(app, "/api/agent/sessions/ws-approval-session/ws");
    try {
      // The durable projector replays the still-pending requirement before the
      // response, consistently for Local and SaaS runtimes.
      await expect(client.receiveJson()).resolves.toMatchObject({
        type: "session.reconnect",
        payload: { phase: "start" },
      });
      await expect(client.receiveJson()).resolves.toMatchObject({
        type: "interaction",
        call_id: approvalId,
        payload: { kind: "approval", phase: "required" },
      });
      await expect(client.receiveJson()).resolves.toMatchObject({
        type: "session.reconnect",
        payload: { phase: "end" },
      });
      // 上行改为 ClientToServerEnvelope：interaction(approval, responded)。
      client.ws.send(JSON.stringify({
        type: "interaction",
        session_id: "ws-approval-session",
        call_id: approvalId,
        payload: {
          kind: "approval",
          phase: "responded",
          approved: true,
          message: "ok",
        },
      }));

      // The transport ack is immediate; the durable interaction event follows its async commit.
      const first = await client.receiveJson();
      const second = await client.receiveJson();
      const ack = first.type === "ack" ? first : second;
      const responded = first.type === "interaction" ? first : second;
      expect(ack).toMatchObject({
        type: "ack",
        session_id: "ws-approval-session",
        payload: {
          category: "interaction",
          ok: true,
          ref_call_id: approvalId,
        },
      });

      expect(responded).toMatchObject({
        type: "interaction",
        session_id: "ws-approval-session",
        call_id: approvalId,
        payload: {
          kind: "approval",
          phase: "responded",
          approved: true,
          message: "ok",
        },
      });
      expect(await approvalPromise).toMatchObject({
        approvalId,
        approved: true,
        message: "ok",
      });
      expect(
        harness.localInfrastructure.conversationStore
          .listOutboxForReplay({ sessionId: "ws-approval-session" })
          .map((row) => row.event_type),
      ).toEqual([
        "client.interaction",
        "client.interaction",
      ]);
    } finally {
      client.ws.terminate();
    }
  });

  it("responds to approval for a non-existent call with ack carrying ref_call_id (ok=false)", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.localInfrastructure.conversationStore.createSession(LOCAL_TENANT_ID, "ws-approval-missing", "usr_local");

    const client = await connectWs(app, "/api/agent/sessions/ws-approval-missing/ws");
    try {
      // 不存在的 approval（已取消/不存在）→ respondApproval 返回 false → ack(ok=false)。
      // 关键：ack 必须带 ref_call_id，前端据此移除残留 approval 弹窗，避免点击失败后弹窗卡死。
      client.ws.send(JSON.stringify({
        type: "interaction",
        session_id: "ws-approval-missing",
        call_id: "missing-approval",
        payload: { kind: "approval", phase: "responded", approved: true, message: "" },
      }));

      const ack = await client.receiveJson();
      expect(ack).toMatchObject({
        type: "ack",
        session_id: "ws-approval-missing",
        payload: {
          category: "interaction",
          ok: false,
          ref_call_id: "missing-approval",
          error: expect.any(String),
        },
      });
    } finally {
      client.ws.terminate();
    }
  });

  it("replays durable outbox events stamped with seq via after_seq cursor", async () => {
    const harness = await buildTestHarness();
    app = harness.app;
    harness.localInfrastructure.conversationStore.createSession(LOCAL_TENANT_ID, "ws-durable-session", "usr_local");
    harness.localInfrastructure.conversationStore.appendOutbox({
      sessionId: "ws-durable-session",
      runId: "run-durable",
      eventId: "event-durable-1",
      eventType: "client.run_ended",
      aggregateType: "run",
      aggregateId: "run-durable",
      payload: {
        client_event: {
          type: "run_ended",
          session_id: "ws-durable-session",
          run_id: "run-durable",
          payload: { status: "completed" },
        },
      },
    });

    const client = await connectWs(app, "/api/agent/sessions/ws-durable-session/ws?after_seq=0");
    try {
      const reconnectStart = await client.receiveJson();
      const replayed = await client.receiveJson();
      const reconnectEnd = await client.receiveJson();

      expect(reconnectStart).toMatchObject({
        type: "session.reconnect",
        session_id: "ws-durable-session",
        run_id: "run-durable",
        payload: { phase: "start", replay_count: 1, replay_source: "durable_outbox" },
      });
      expect(reconnectStart?.seq).toBeUndefined();
      expect(replayed).toMatchObject({
        type: "run_ended",
        session_id: "ws-durable-session",
        run_id: "run-durable",
        message_id: "event-durable-1",
        seq: 1,
        payload: { status: "completed" },
      });
      expect(reconnectEnd).toMatchObject({
        type: "session.reconnect",
        session_id: "ws-durable-session",
        payload: { phase: "end", replay_source: "durable_outbox" },
      });
      expect(reconnectEnd?.seq).toBeUndefined();
    } finally {
      client.ws.terminate();
    }
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

async function connectWs(app: FastifyInstance, path: string) {
  const messages: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  const ws = await app.injectWS(path, {}, {
    onInit(socket) {
      socket.on("message", (data: { toString(): string }) => {
        const raw = data.toString();
        const waiter = waiters.shift();
        if (waiter) {
          waiter(raw);
          return;
        }
        messages.push(raw);
      });
    },
  });

  return {
    ws,
    receiveJson: async (timeoutMs = 1000) => {
      const queued = messages.shift();
      const raw = queued ?? await new Promise<string | null>((resolve) => {
        const waiter = (value: string | null): void => {
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);
        waiters.push(waiter);
      });
      return raw === null ? null : JSON.parse(raw);
    },
  };
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
