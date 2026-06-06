import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatCompletionRequest, LlmChatClient } from "../../src/services/llm-chat-client.js";
import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;
const heldClients: HoldableChatClient[] = [];

afterEach(async () => {
  for (const client of heldClients.splice(0)) {
    client.release();
  }
  if (app) {
    await app.close();
    app = null;
  }
});

class HoldableChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];
  private releaseCurrent: (() => void) | null = null;

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    await new Promise<void>((resolve) => {
      this.releaseCurrent = resolve;
    });
    if (request.signal?.aborted) {
      throw new Error("aborted");
    }
    return { content: "held answer" };
  }

  release(): void {
    this.releaseCurrent?.();
    this.releaseCurrent = null;
  }
}

describe("session websocket route", () => {
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

  it("replays only the current active run history with monotonic stream_seq", async () => {
    const chatClient = new HoldableChatClient();
    heldClients.push(chatClient);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.container.events.publish("ws-active-session", {
      type: "output.chunk",
      session_id: "ws-active-session",
      run_id: "old-run",
      data: { content: "old" },
      content: { content: "old" },
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

    await waitFor(() => chatClient.requests.length === 1);
    harness.container.events.publish("ws-active-session", {
      type: "user.approval_required",
      session_id: "ws-active-session",
      run_id: runId,
      data: { approval_id: "stale-approval" },
      content: { approval_id: "stale-approval" },
    });

    const client = await connectWs(app, "/api/agent/sessions/ws-active-session/ws");
    try {
      const reconnectStart = await client.receiveJson();
      expect(reconnectStart).toMatchObject({
        type: "reconnect_start",
        session_id: "ws-active-session",
        run_id: runId,
        stream_seq: 1,
      });
      expect(reconnectStart?.replay_count).toBeGreaterThan(0);

      const replayed = [];
      for (let index = 0; index < Number(reconnectStart?.replay_count ?? 0); index += 1) {
        replayed.push(await client.receiveJson());
      }
      const reconnectEnd = await client.receiveJson();

      expect(reconnectEnd).toMatchObject({
        type: "reconnect_end",
        session_id: "ws-active-session",
        stream_seq: replayed.length + 2,
      });
      expect(replayed.every((event) => event?.run_id === runId || event?.data?.run_id === runId)).toBe(true);
      expect(replayed.some((event) => event?.type === "session.run_started")).toBe(true);
      expect(replayed.some((event) => event?.run_id === "old-run" || event?.data?.content === "old")).toBe(false);
      expect(replayed.some((event) => event?.data?.approval_id === "stale-approval")).toBe(false);
      expect([reconnectStart, ...replayed, reconnectEnd].map((event) => event?.stream_seq)).toEqual(
        Array.from({ length: replayed.length + 2 }, (_, index) => index + 1),
      );
    } finally {
      client.ws.terminate();
      await harness.container.agentExecution.stopSession("ws-active-session");
      chatClient.release();
    }
  });

  it("responds to legacy approval messages with the Python-compatible approval event first", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    const approvalPromise = harness.container.pendingInteractions.waitForApproval({
      sessionId: "ws-approval-session",
      runId: "run-approval",
      toolName: "execute_bash",
      description: "Run command",
    });
    const required = harness.container.events
      .getHistory("ws-approval-session")
      .find((event) => event.type === "user.approval_required");
    const requiredData = required?.data && typeof required.data === "object"
      ? required.data as Record<string, unknown>
      : {};
    const approvalId = typeof requiredData.approval_id === "string" ? requiredData.approval_id : "";
    expect(approvalId).toBeTruthy();

    const client = await connectWs(app, "/api/agent/sessions/ws-approval-session/ws");
    try {
      client.ws.send(JSON.stringify({
        type: "approve",
        approval_id: approvalId,
        approved: true,
        message: "ok",
      }));

      const ack = await client.receiveJson();
      expect(ack).toMatchObject({
        type: "user.approval_granted",
        session_id: "ws-approval-session",
        approval_id: approvalId,
        stream_seq: 1,
        data: {
          approval_id: approvalId,
          approved: true,
          message: "ok",
        },
      });
      expect(await approvalPromise).toMatchObject({
        approvalId,
        approved: true,
        message: "ok",
      });
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
