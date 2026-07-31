import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WidgetAgentClient } from "../src/adapter/widget-agent-client.js";

const chatPanelSource = readFileSync(new URL("../src/components/ChatPanel.vue", import.meta.url), "utf8");

describe("ChatPanel runtime actions", () => {
  it("renders stop and resume independently for suspended runs", () => {
    expect(chatPanelSource).toContain('v-if="canStopRun"');
    expect(chatPanelSource).toContain('v-if="canResumeRun"');
    expect(chatPanelSource).not.toContain('v-else-if="canResumeRun"');
    expect(chatPanelSource).toContain('v-if="!canStopRun && !canResumeRun"');
  });
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void { this.sent.push(data); }
  close(): void {}
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
    observed_at: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function sendEnvelope(socket: FakeWebSocket | undefined, envelope: Record<string, unknown>): void {
  socket?.onmessage?.({ data: JSON.stringify(envelope) });
}

function sentMessages(socket: FakeWebSocket | undefined): Record<string, unknown>[] {
  return (socket?.sent ?? []).map((message) => JSON.parse(message) as Record<string, unknown>);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("WidgetAgentClient websocket ticket", () => {
  it("uses the Widget JWT only for HTTP ticket issuance", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });

    await client.connect();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/widget/sessions/session-1/ws-ticket",
      { method: "POST", headers: { authorization: "Bearer widget-jwt" } },
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "wss://api.example.test/api/agent/sessions/session-1/ws?ticket=one-time-ticket",
    );
    expect(FakeWebSocket.instances[0]?.url).not.toContain("widget-jwt");
    client.disconnect();
  });

  it("uses the shared durable cursor to drop duplicate envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    })));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });
    const received: string[] = [];
    client.events.subscribe((event) => received.push(event.type));

    await client.connect();
    const envelope = JSON.stringify({
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      seq: 4,
      payload: { phase: "delta", content: "hello" },
    });
    FakeWebSocket.instances[0]?.onmessage?.({ data: envelope });
    FakeWebSocket.instances[0]?.onmessage?.({ data: envelope });

    expect(received).toEqual(["stream_output"]);
    client.disconnect();
  });

  it("accepts slash-command send acks without leaving the widget in a running state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    })));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });
    const states: string[] = [];
    client.runStatus.subscribe((status) => states.push(status.state));

    await client.connect();
    const socket = FakeWebSocket.instances[0];
    sendEnvelope(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot(),
    });
    const sent = client.send({ task: "/help" });
    await flushMicrotasks();
    sendEnvelope(socket, {
      type: "ack",
      session_id: "session-1",
      payload: { category: "send", ok: true, kind: "command" },
    });
    sendEnvelope(socket, {
      type: "state_sync",
      session_id: "session-1",
      payload: {
        category: "command_result",
        detail: { success: true, content: "available commands" },
      },
    });

    await expect(sent).resolves.toMatchObject({ started: true });
    expect(states).toEqual(["idle", "idle"]);
    expect(states).not.toContain("running");
    client.disconnect();
  });

  it("does not infer lifecycle or interactions from raw execution envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    })));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });
    const states: string[] = [];
    const interactions: string[][] = [];
    client.runStatus.subscribe((status) => states.push(status.state));
    client.pendingInteractions.subscribe((pending) => interactions.push(pending.map((item) => item.interactionId)));

    await client.connect();
    const socket = FakeWebSocket.instances[0];
    sendEnvelope(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot(),
    });
    sendEnvelope(socket, {
      type: "run_started",
      session_id: "session-1",
      run_id: "run-1",
      payload: { task: "task" },
    });
    sendEnvelope(socket, {
      type: "interaction",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "interaction-1",
      payload: { kind: "approval", phase: "required", tool: "write_file" },
    });
    sendEnvelope(socket, {
      type: "run_ended",
      session_id: "session-1",
      run_id: "run-1",
      payload: { status: "completed" },
    });

    expect(states).toEqual(["idle", "idle"]);
    expect(interactions).toEqual([[], []]);
    client.disconnect();
  });

  it("rebuilds pending interactions from session.runtime and keeps them until the next snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    })));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });

    await client.connect();
    const socket = FakeWebSocket.instances[0];
    const activeRun = {
      run_id: "run-1",
      status: "waiting_interaction",
      execution_owner: "attached",
      task: "task",
      request_id: "request-1",
      execution_kind: "agent_stream",
      started_at: "2026-07-30T00:00:00.000Z",
      updated_at: "2026-07-30T00:00:01.000Z",
    };
    const pending = {
      interaction_id: "interaction-1",
      run_id: "run-1",
      root_run_id: "run-1",
      batch_id: "batch-1",
      kind: "approval",
      status: "waiting",
      requested_at: "2026-07-30T00:00:01.000Z",
      payload: {
        kind: "approval",
        phase: "required",
        tool: "write_file",
        prompt: "允许写入吗？",
      },
    };
    sendEnvelope(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot({
        state: "waiting_interaction",
        load_strategy: "attach_run_and_present_interactions",
        allowed_actions: ["respond_interaction", "stop_run"],
        active_run: activeRun,
        pending_interactions: [pending],
      }),
    });

    expect(client.pendingInteractions.get()).toMatchObject([{
      interactionId: "interaction-1",
      status: "waiting",
      prompt: "允许写入吗？",
    }]);
    const response = client.approve("interaction-1", true);
    await flushMicrotasks();
    sendEnvelope(socket, {
      type: "ack",
      session_id: "session-1",
      payload: { category: "interaction", ok: true, ref_call_id: "interaction-1" },
    });
    await expect(response).resolves.toBeUndefined();
    expect(client.pendingInteractions.get()).toHaveLength(1);

    sendEnvelope(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot({
        state: "running",
        load_strategy: "attach_run",
        allowed_actions: ["send_followup", "stop_run"],
        active_run: { ...activeRun, status: "running", updated_at: "2026-07-30T00:00:02.000Z" },
      }),
    });
    expect(client.pendingInteractions.get()).toEqual([]);
    client.disconnect();
  });

  it("rejects remote-owned interaction responses without sending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    })));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });

    await client.connect();
    const socket = FakeWebSocket.instances[0];
    sendEnvelope(socket, {
      type: "session.runtime",
      session_id: "session-1",
      payload: runtimeSnapshot({
        state: "waiting_interaction",
        load_strategy: "attach_run_and_present_interactions",
        allowed_actions: [],
        active_run: {
          run_id: "run-1",
          status: "waiting_interaction",
          execution_owner: "remote",
          task: "task",
          request_id: null,
          execution_kind: "agent_stream",
          started_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-30T00:00:01.000Z",
        },
        pending_interactions: [{
          interaction_id: "interaction-1",
          run_id: "run-1",
          root_run_id: "run-1",
          batch_id: "batch-1",
          kind: "approval",
          status: "waiting",
          requested_at: "2026-07-30T00:00:01.000Z",
          payload: { kind: "approval", phase: "required" },
        }],
      }),
    });
    const before = sentMessages(socket).length;

    await expect(client.approve("interaction-1", true)).rejects.toThrow("不允许响应交互");
    expect(sentMessages(socket)).toHaveLength(before);
    client.disconnect();
  });

  it("resumes only the interaction selected by suspended runtime", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    })));
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });

    await client.connect();
    const socket = FakeWebSocket.instances[0];
    sendEnvelope(socket, {
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
          started_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-30T00:00:01.000Z",
        },
        resume_interaction_id: "interaction-1",
      }),
    });
    const resumed = client.resume();
    await flushMicrotasks();
    const resumeMessage = sentMessages(socket).at(-1) as {
      payload?: { request_id?: string };
    } | undefined;
    expect(resumeMessage).toEqual({
      type: "resume",
      session_id: "session-1",
      call_id: "interaction-1",
      payload: { request_id: expect.any(String) },
    });
    sendEnvelope(socket, {
      type: "ack",
      session_id: "session-1",
      payload: {
        category: "resume",
        ok: true,
        ref_call_id: "interaction-1",
        request_id: resumeMessage?.payload?.request_id,
      },
    });

    await expect(resumed).resolves.toBe(true);
    client.disconnect();
  });
});
