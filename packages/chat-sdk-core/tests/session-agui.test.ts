import { describe, expect, it, vi } from "vitest";

import { SessionAgentClient } from "../src/session-client.js";

class ConnectedSocket {
  readonly readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void { this.onclose?.({ code: 1000, reason: "" }); }
}

describe("SessionAgentClient AG-UI fallback", () => {
  it("keeps every unsequenced text chunk and does not duplicate TOOL_CALL_END", async () => {
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      aguiFallback: (input, onEvent) => {
        callbacks.push(onEvent as unknown as (event: Record<string, unknown>) => void);
        return {
          started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}),
          abort: vi.fn(),
        };
      },
    });
    const events: string[] = [];
    client.events.subscribe((event) => events.push(event.type));

    await client.send({ task: "stream" });
    callbacks[0]?.({ type: "RUN_STARTED", threadId: "session-1", runId: "run-1" });
    callbacks[0]?.({ type: "TEXT_MESSAGE_CONTENT", threadId: "session-1", runId: "run-1", messageId: "m-1", delta: "one" });
    callbacks[0]?.({ type: "TEXT_MESSAGE_CONTENT", threadId: "session-1", runId: "run-1", messageId: "m-1", delta: "two" });
    callbacks[0]?.({ type: "TOOL_CALL_START", threadId: "session-1", runId: "run-1", toolCallId: "call-1", toolCallName: "lookup" });
    callbacks[0]?.({ type: "TOOL_CALL_END", threadId: "session-1", runId: "run-1", toolCallId: "call-1" });

    expect(events.filter((type) => type === "stream_output")).toHaveLength(2);
    expect(events.filter((type) => type === "tool_call")).toHaveLength(1);
    client.disconnect();
  });

  it("restores AG-UI reasoning events as intent stream envelopes", async () => {
    let onEvent: ((event: Record<string, unknown>) => void) | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      aguiFallback: (input, callback) => {
        onEvent = callback as unknown as (event: Record<string, unknown>) => void;
        return {
          started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}),
          abort: vi.fn(),
        };
      },
    });
    const phases: string[] = [];
    client.events.subscribe((event) => {
      if (event.type === "stream_output") phases.push(String(event.payload?.phase));
    });

    await client.send({ task: "reasoning" });
    onEvent?.({ type: "REASONING_MESSAGE_START", runId: "run-1", messageId: "reason-1" });
    onEvent?.({ type: "REASONING_MESSAGE_CONTENT", runId: "run-1", messageId: "reason-1", delta: "思考" });
    onEvent?.({ type: "REASONING_MESSAGE_END", runId: "run-1", messageId: "reason-1" });

    expect(phases).toEqual(["intent_delta", "intent_delta", "intent_complete"]);
    client.disconnect();
  });

  it("restores AG-UI model request CUSTOM events as authoritative envelopes", async () => {
    let onEvent: ((event: Record<string, unknown>) => void) | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      aguiFallback: (input, callback) => {
        onEvent = callback as unknown as (event: Record<string, unknown>) => void;
        return {
          started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}),
          abort: vi.fn(),
        };
      },
    });
    const envelopes: Array<{ type: string; phase?: unknown; round?: unknown }> = [];
    client.events.subscribe((event) => {
      if (event.type === "model_request") {
        envelopes.push({
          type: event.type,
          phase: event.payload?.phase,
          round: event.payload?.round,
        });
      }
    });

    await client.send({ task: "model" });
    onEvent?.({
      type: "CUSTOM",
      threadId: "session-1",
      runId: "run-1",
      name: "model_request",
      value: { phase: "start", round: 4 },
    });

    expect(envelopes).toEqual([{ type: "model_request", phase: "start", round: 4 }]);
    client.disconnect();
  });

  it("converts a post-start SSE failure into a terminal failed run", async () => {
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    let rejectCompleted: ((error: Error) => void) | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      aguiFallback: (input, onEvent) => {
        callbacks.push(onEvent as unknown as (event: Record<string, unknown>) => void);
        return {
          started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise((_, reject) => { rejectCompleted = reject; }),
          abort: vi.fn(),
        };
      },
    });
    const events: string[] = [];
    client.events.subscribe((event) => events.push(event.type));

    await client.send({ task: "stream" });
    callbacks[0]?.({ type: "RUN_STARTED", threadId: "session-1", runId: "run-1" });
    rejectCompleted?.(new Error("SSE disconnected"));
    await Promise.resolve();
    await Promise.resolve();

    expect(client.runStatus.get()).toMatchObject({ state: "failed" });
    expect(events).toEqual(expect.arrayContaining(["error", "run_ended"]));
    client.disconnect();
  });

  it("projects interrupts and resumes them over SSE", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      hostTools: [{
        name: "host_tool",
        description: "host tool",
        inputSchema: { type: "object" },
        execute: async () => ({ ok: true }),
      }],
      aguiFallback: (input, onEvent) => {
        inputs.push(input as unknown as Record<string, unknown>);
        callbacks.push(onEvent as unknown as (event: Record<string, unknown>) => void);
        const started = Promise.resolve({ type: "RUN_STARTED", threadId: "session-1", runId: input.runId });
        return {
          started,
          completed: new Promise(() => {}),
          abort: vi.fn(),
        };
      },
    });

    const send = await client.send({ task: "需要输入", uiContext: { panel: "chat" } });
    expect(send).toMatchObject({ started: true, kind: "agent_run" });
    expect(inputs[0]).toMatchObject({
      tools: [{ name: "host_tool" }],
      forwardedProps: { uiContext: { panel: "chat" } },
    });

    callbacks[0]?.({
      type: "RUN_FINISHED",
      threadId: "session-1",
      runId: "run-1",
      eventSeq: 1,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "interrupt-1", reason: "input_required", message: "请输入" }],
      },
    });
    expect(client.pendingInteractions.get()).toEqual(expect.arrayContaining([
      expect.objectContaining({ interactionId: "interrupt-1", kind: "user_input" }),
    ]));
    expect(client.runtime.get()).toMatchObject({
      state: "suspended",
      allowed_actions: ["respond_interaction", "stop_run"],
    });
    expect(client.runStatus.get()).toMatchObject({ state: "interrupted" });

    await client.respondInteraction("interrupt-1", { kind: "user_input", value: "回答" });
    expect(inputs[1]).toMatchObject({
      resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { value: "回答" } }],
    });
    expect(client.pendingInteractions.get()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ interactionId: "interrupt-1" }),
    ]));
    client.disconnect();
  });

  it("keeps AG-UI interrupts on the SSE resume path after WS recovery", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    let socket: ConnectedSocket | undefined;
    const cancelAguiRun = vi.fn(async () => {});
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      createWebSocket: () => {
        socket = new ConnectedSocket();
        queueMicrotask(() => socket?.onopen?.());
        return socket as unknown as WebSocket;
      },
      cancelAguiRun,
      aguiFallback: (input, onEvent) => {
        inputs.push(input as unknown as Record<string, unknown>);
        callbacks.push(onEvent as unknown as (event: Record<string, unknown>) => void);
        return {
          started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}),
          abort: vi.fn(),
        };
      },
    });

    await expect(client.send({ task: "需要审批" })).resolves.toMatchObject({ started: true });
    callbacks[0]?.({
      type: "RUN_STARTED",
      threadId: "session-1",
      runId: "run-1",
    });
    callbacks[0]?.({
      type: "RUN_FINISHED",
      threadId: "session-1",
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "interrupt-1", reason: "input_required", message: "请输入" }],
      },
    });

    await client.connect();
    await client.respondInteraction("interrupt-1", { kind: "user_input", value: "回答" });

    expect(inputs[1]).toMatchObject({
      resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { value: "回答" } }],
    });
    expect(socket?.sent.map((value) => JSON.parse(value).type)).not.toContain("interaction");
    client.disconnect();
  });

  it("cancels AG-UI before using a recovered WS stop path", async () => {
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    let socket: ConnectedSocket | undefined;
    const cancelAguiRun = vi.fn(async () => {});
    const abort = vi.fn();
    const events: string[] = [];
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      createWebSocket: () => {
        socket = new ConnectedSocket();
        queueMicrotask(() => socket?.onopen?.());
        return socket as unknown as WebSocket;
      },
      cancelAguiRun,
      aguiFallback: (input, onEvent) => {
        callbacks.push(onEvent as unknown as (event: Record<string, unknown>) => void);
        return {
          started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}),
          abort,
        };
      },
    });
    client.events.subscribe((event) => events.push(event.type));

    await client.send({ task: "停止" });
    callbacks[0]?.({ type: "RUN_STARTED", runId: "run-1", threadId: "session-1" });
    await client.connect();
    client.stop();

    expect(abort).toHaveBeenCalledWith("run stopped");
    expect(cancelAguiRun).toHaveBeenCalledWith("session-1", "run-1");
    expect(socket?.sent.map((value) => JSON.parse(value).type)).not.toContain("stop");
    const eventCountAfterStop = events.length;
    callbacks[0]?.({ type: "TEXT_MESSAGE_CONTENT", runId: "run-1", messageId: "m-1", delta: "late" });
    callbacks[0]?.({ type: "RUN_STARTED", runId: "run-stale", threadId: "session-1" });
    expect(events).toHaveLength(eventCountAfterStop);
    expect(client.runtime.get()).toMatchObject({ state: "idle", active_run: null });
    client.disconnect();
  });
});
