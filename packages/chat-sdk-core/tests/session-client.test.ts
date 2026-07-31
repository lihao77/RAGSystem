import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionAgentClient } from "../src/session-client.js";

class ControlledWebSocket {
  readonly readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  open(): void {
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

function runtimeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    state: "idle",
    load_strategy: "history",
    allowed_actions: ["send_message", "start_maintenance"],
    active_run: null,
    last_run: null,
    pending_interactions: [],
    resume_interaction_id: null,
    maintenance: null,
    observed_at: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function deliver(socket: ControlledWebSocket, envelope: Record<string, unknown>): void {
  socket.onmessage?.({ data: JSON.stringify(envelope) });
}

function messages(socket: ControlledWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
}

async function connectedClient(): Promise<{
  client: SessionAgentClient;
  socket: ControlledWebSocket;
}> {
  const sockets: ControlledWebSocket[] = [];
  const client = new SessionAgentClient({
    baseUrl: "https://rag.example.test",
    sessionId: "session-1",
    issueWsTicket: async () => "ticket-1",
    createWebSocket: (url) => {
      const socket = new ControlledWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const connecting = client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const socket = sockets[0];
  if (!socket) throw new Error("WebSocket was not created");
  socket.open();
  await connecting;
  return { client, socket };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionAgentClient ACK correlation", () => {
  it("does not resolve a later send with an earlier timed-out ACK", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    deliver(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot(),
    });

    const first = client.send({ task: "first", requestId: "request-1" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toMatchObject({ started: false, requestId: "request-1" });

    const second = client.send({ task: "second", requestId: "request-2" });
    await vi.advanceTimersByTimeAsync(0);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    deliver(socket, {
      type: "ack",
      session_id: "session-1",
      payload: { category: "send", ok: true, request_id: "request-1" },
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    deliver(socket, {
      type: "ack",
      session_id: "session-1",
      payload: { category: "send", ok: true, request_id: "request-2" },
    });
    await expect(second).resolves.toMatchObject({ started: true, requestId: "request-2" });
    client.disconnect();
  });

  it("does not resolve a later resume with an earlier timed-out ACK", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient();
    deliver(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot({
        state: "suspended",
        load_strategy: "restore_suspended_run_and_present_interactions",
        allowed_actions: ["resume_run", "stop_run"],
        active_run: {
          run_id: "run-1",
          status: "suspended",
          execution_owner: "detached",
          task: "task",
          request_id: null,
          execution_kind: "agent_stream",
          started_at: "2026-07-31T00:00:00.000Z",
          updated_at: "2026-07-31T00:00:01.000Z",
        },
        resume_interaction_id: "interaction-1",
      }),
    });

    const first = client.resume();
    await vi.advanceTimersByTimeAsync(0);
    const firstMessage = messages(socket).filter((message) => message.type === "resume").at(-1) as {
      payload: { request_id: string };
    };
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(first).resolves.toBe(false);

    const second = client.resume();
    await vi.advanceTimersByTimeAsync(0);
    const secondMessage = messages(socket).filter((message) => message.type === "resume").at(-1) as {
      payload: { request_id: string };
    };
    expect(secondMessage.payload.request_id).not.toBe(firstMessage.payload.request_id);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });

    deliver(socket, {
      type: "ack",
      session_id: "session-1",
      payload: {
        category: "resume",
        ok: true,
        ref_call_id: "interaction-1",
        request_id: firstMessage.payload.request_id,
      },
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    deliver(socket, {
      type: "ack",
      session_id: "session-1",
      payload: {
        category: "resume",
        ok: true,
        ref_call_id: "interaction-1",
        request_id: secondMessage.payload.request_id,
      },
    });
    await expect(second).resolves.toBe(true);
    client.disconnect();
  });
});

describe("SessionAgentClient connection lifecycle", () => {
  it("does not leak an unhandled rejection when a background connect is disconnected", async () => {
    vi.useFakeTimers();
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      createWebSocket: (url) => new ControlledWebSocket(url) as unknown as WebSocket,
    });

    void client.connect();
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();
    await Promise.resolve();
  });

  it("still rejects an awaited connect when it is disconnected before opening", async () => {
    vi.useFakeTimers();
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      createWebSocket: (url) => new ControlledWebSocket(url) as unknown as WebSocket,
    });

    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();
    await expect(connecting).rejects.toThrow("连接失败");
  });
});
