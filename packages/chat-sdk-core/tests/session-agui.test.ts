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

function recoverySnapshot(state: "idle" | "running" = "idle") {
  return { type: "session.snapshot", session_id: "session-1", payload: {
    event_watermark: 12,
    runtime: { state, event_watermark: 12,
      load_strategy: state === "running" ? "attach_run" : "history",
      allowed_actions: state === "running" ? ["send_followup", "stop_run"] : ["send_message", "start_maintenance"],
      active_run: state === "running" ? { run_id: "internal-run", status: "running", execution_owner: "attached",
        task: "host tool", request_id: null, execution_kind: "agui_stream", started_at: "2026-10-10T00:00:00Z",
        updated_at: "2026-10-10T00:00:00Z", activity: { models: [], tools: [], updated_at: "2026-10-10T00:00:00Z" } } : null,
      last_run: null, pending_interactions: [], resume_interaction_id: null, maintenance: null,
      observed_at: "2026-10-10T00:00:00Z" },
    messages: { items: [], has_more: false, before_seq: null }, participants: [], pending_requests: [],
    execution: [], tree: { root: null },
  } };
}

describe("SessionAgentClient AG-UI fallback", () => {
  it("delivers session overview changes during SSE ownership and deduplicates WS/SSE copies", async () => {
    let socket: ConnectedSocket | undefined;
    let callback: ((event: Record<string, unknown>) => void) | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test", sessionId: "session-1", issueWsTicket: async () => "ticket",
      createWebSocket: () => {
        socket = new ConnectedSocket(); queueMicrotask(() => socket?.onopen?.());
        return socket as unknown as WebSocket;
      },
      aguiFallback: (input, onEvent) => {
        callback = onEvent as unknown as typeof callback;
        return { started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}), abort: vi.fn() };
      },
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    client.events.subscribe(event => events.push(event));
    await client.send({ task: "stream" });
    await client.connect();
    socket?.onmessage?.({ data: JSON.stringify({ type: "run_started", session_id: "session-1", run_id: "duplicate", payload: {} }) });
    for (const [index, entity] of ['goal', 'background_task'].entries()) {
      socket?.onmessage?.({ data: JSON.stringify({ type: "state_sync", session_id: "session-1", seq: index + 1,
        payload: { category: "session_updated", detail: { entity } } }) });
      callback?.({ type: "CUSTOM", name: "session_updated", eventSeq: index + 1,
        value: { detail: { entity } } });
    }
    callback?.({ type: "CUSTOM", name: "session_updated", eventSeq: 3, value: { detail: { entity: "goal" } } });
    expect(events.map(event => event.type)).toEqual(['state_sync', 'state_sync', 'state_sync']);
    expect(events[2]?.payload).toMatchObject({ category: "session_updated", detail: { entity: "goal" } });
    client.disconnect();
  });
  it.each(["before result", "during submission"])("keeps delegated results across snapshot takeover %s", async (takeover) => {
    const inputs: Array<Record<string, unknown>> = [];
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    const aborts: Array<ReturnType<typeof vi.fn>> = [];
    let finishTool!: (result: { ok: boolean; observation: string }) => void;
    let socket: ConnectedSocket | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test", sessionId: "session-1", issueWsTicket: async () => "ticket-1",
      createWebSocket: () => {
        socket = new ConnectedSocket();
        queueMicrotask(() => socket?.onopen?.());
        return socket as unknown as WebSocket;
      },
      hostTools: [{ name: "host_tool", description: "host tool", inputSchema: {},
        execute: () => new Promise(resolve => { finishTool = resolve; }) }],
      aguiFallback: (input, callback) => {
        inputs.push(input as unknown as Record<string, unknown>);
        callbacks.push(callback as unknown as (event: Record<string, unknown>) => void);
        const abort = vi.fn(); aborts.push(abort);
        return { started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}), abort };
      },
    });
    const events: string[] = [];
    client.events.subscribe(event => events.push(event.type));
    await client.send({ task: "host tool" });
    callbacks[0]?.({ type: "RUN_STARTED", runId: "external-run" });
    callbacks[0]?.({ type: "RUN_FINISHED", runId: "external-run", outcome: { type: "interrupt",
      interrupts: [{ id: "host-call", reason: "tool_call", metadata: { toolName: "host_tool", arguments: { value: 1 } } }] } });
    await client.connect();
    if (takeover === "during submission") {
      finishTool({ ok: true, observation: "result" });
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    }
    socket?.onmessage?.({ data: JSON.stringify(recoverySnapshot()) });
    expect(events).toContain("session.snapshot");
    if (takeover === "before result") finishTool({ ok: true, observation: "result" });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ resume: [{ interruptId: "host-call", status: "resolved",
      payload: { ok: true, observation: "result" } }] });
    expect(aborts[1]).not.toHaveBeenCalled();
    const projectedCount = events.length;
    for (const callback of callbacks) {
      callback({ type: "RUN_STARTED", runId: "stale-sse-run" });
      callback({ type: "RUN_ERROR", runId: "stale-sse-run", message: "late failure" });
    }
    expect(events).toHaveLength(projectedCount);
    expect(client.runtime.get()).toMatchObject({ state: "idle", active_run: null });
    socket?.onmessage?.({ data: JSON.stringify(recoverySnapshot("running")) });
    expect(client.runtime.get()).toMatchObject({ state: "running", active_run: { run_id: "internal-run" } });
    client.stop();
    expect(aborts[1]).toHaveBeenCalledWith("run stopped");
    expect(socket?.sent.map(value => JSON.parse(value).type)).toContain("abort");
    client.disconnect();
  });

  it.each(["stop", "disconnect"] as const)("clears deferred delegated requests on %s after snapshot takeover", async (action) => {
    let callback: ((event: Record<string, unknown>) => void) | undefined;
    let finishTool!: (result: { ok: boolean }) => void;
    let signal: AbortSignal | undefined;
    let socket: ConnectedSocket | undefined;
    const inputs: Array<Record<string, unknown>> = [];
    const cancelAguiRun = vi.fn(async () => {});
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test", sessionId: "session-1", issueWsTicket: async () => "ticket-1",
      cancelAguiRun,
      createWebSocket: () => {
        socket = new ConnectedSocket(); queueMicrotask(() => socket?.onopen?.());
        return socket as unknown as WebSocket;
      },
      hostTools: [{ name: "host_tool", description: "host tool", inputSchema: {}, execute: (_input, context) => {
        signal = context.signal; return new Promise(resolve => { finishTool = resolve; });
      } }],
      aguiFallback: (input, onEvent) => {
        inputs.push(input as unknown as Record<string, unknown>); callback = onEvent as unknown as typeof callback;
        return { started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}), abort: vi.fn() };
      },
    });
    await client.send({ task: "host tool" });
    callback?.({ type: "RUN_FINISHED", runId: "external-run", outcome: { type: "interrupt",
      interrupts: [{ id: "host-call", reason: "tool_call", metadata: { toolName: "host_tool" } }] } });
    await client.connect();
    socket?.onmessage?.({ data: JSON.stringify(recoverySnapshot("running")) });
    const followup = client.send({ task: "followup", requestId: "followup-1" });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(socket?.sent.map(value => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: "user_driven_change", payload: expect.objectContaining({ task: "followup", request_id: "followup-1" }),
    }));
    socket?.onmessage?.({ data: JSON.stringify({ type: "ack", session_id: "session-1",
      payload: { category: "send", ok: true, request_id: "followup-1" } }) });
    await expect(followup).resolves.toMatchObject({ started: true, requestId: "followup-1" });
    client[action]();
    expect(signal?.aborted).toBe(true);
    finishTool({ ok: true });
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(inputs).toHaveLength(1);
    expect(cancelAguiRun).not.toHaveBeenCalled();
    client.disconnect();
  });

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
    const envelopes: Array<{ type: string; callId?: string; agentId?: string; phase?: unknown; round?: unknown }> = [];
    client.events.subscribe((event) => {
      if (event.type === "model_request") {
        envelopes.push({
          type: event.type,
          callId: event.call_id,
          agentId: event.agent_id,
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
      value: {
        call_id: "root-call",
        agent_id: "agent-1",
        payload: { phase: "start", round: 4 },
      },
    });

    expect(envelopes).toEqual([{
      type: "model_request",
      callId: "root-call",
      agentId: "agent-1",
      phase: "start",
      round: 4,
    }]);
    client.disconnect();
  });

  it("restores AG-UI rich content parts on the final stream envelope", async () => {
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
    let finalPayload: Record<string, unknown> | null = null;
    client.events.subscribe((event) => {
      if (event.type === "stream_output" && event.payload?.phase === "final") {
        finalPayload = event.payload as Record<string, unknown>;
      }
    });

    await client.send({ task: "rich" });
    onEvent?.({
      type: "TEXT_MESSAGE_END",
      threadId: "session-1",
      runId: "run-1",
      messageId: "message-1",
      content_parts: [{ type: "file_ref", file_path: "results/map.png", presentation: "inline" }],
    });

    expect(finalPayload).toEqual({
      phase: "final",
      content: "",
      content_parts: [{ type: "file_ref", file_path: "results/map.png", presentation: "inline" }],
    });
    client.disconnect();
  });

  it("restores AG-UI streamed file parts as stream_output envelopes", async () => {
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
    let partPayload: Record<string, unknown> | null = null;
    client.events.subscribe((event) => {
      if (event.type === "stream_output" && event.payload?.phase === "part_added") {
        partPayload = event.payload as Record<string, unknown>;
      }
    });

    await client.send({ task: "rich" });
    onEvent?.({
      type: "CUSTOM",
      threadId: "session-1",
      runId: "run-1",
      name: "stream_output",
      value: {
        phase: "part_added",
        part_index: 1,
        part: { type: "file_ref", file_path: "results/map.png", presentation: "inline" },
      },
    });

    expect(partPayload).toEqual({
      phase: "part_added",
      part_index: 1,
      part: { type: "file_ref", file_path: "results/map.png", presentation: "inline" },
    });
    client.disconnect();
  });

  it("recovers a post-start SSE failure from an authoritative socket snapshot", async () => {
    const callbacks: Array<(event: Record<string, unknown>) => void> = [];
    let rejectCompleted: ((error: Error) => void) | undefined;
    let recoveredSocket: ConnectedSocket | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test",
      sessionId: "session-1",
      issueWsTicket: async () => "ticket-1",
      createWebSocket: () => {
        recoveredSocket = new ConnectedSocket();
        queueMicrotask(() => recoveredSocket?.onopen?.());
        return recoveredSocket as unknown as WebSocket;
      },
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

    expect(client.runStatus.get()).toMatchObject({ state: "running" });
    expect(events).toContain("error");
    expect(events).not.toContain("run_ended");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(recoveredSocket?.onmessage).toBeTypeOf("function");
    recoveredSocket?.onmessage?.({ data: JSON.stringify({
      type: "session.snapshot", session_id: "session-1", payload: {
        event_watermark: 12,
        runtime: { state: "idle", load_strategy: "history", allowed_actions: ["send_message", "start_maintenance"],
          active_run: null, last_run: { run_id: "run-1", status: "completed", reason: null,
            task: "stream", started_at: "2026-10-10T00:00:00Z", finished_at: "2026-10-10T00:00:01Z" },
          pending_interactions: [], resume_interaction_id: null, maintenance: null, observed_at: "2026-10-10T00:00:00Z" },
        messages: { items: [], has_more: false, before_seq: null }, participants: [], pending_requests: [],
        execution: [], tree: { root: null },
      },
    }) });
    expect(client.runtime.get()).toMatchObject({ state: "idle", last_run: { status: "completed" } });
    expect(events).toContain("session.snapshot");
    client.disconnect();
  });

  it("discards SSE-only pending interactions when a socket snapshot takes ownership", async () => {
    let onEvent: ((event: Record<string, unknown>) => void) | undefined;
    let socket: ConnectedSocket | undefined;
    const client = new SessionAgentClient({
      baseUrl: "https://rag.example.test", sessionId: "session-1", issueWsTicket: async () => "ticket-1",
      createWebSocket: () => {
        socket = new ConnectedSocket();
        queueMicrotask(() => socket?.onopen?.());
        return socket as unknown as WebSocket;
      },
      aguiFallback: (input, callback) => {
        onEvent = callback as unknown as typeof onEvent;
        return { started: Promise.resolve({ type: "RUN_STARTED", runId: input.runId }),
          completed: new Promise(() => {}), abort: vi.fn() };
      },
    });
    await client.send({ task: "approval" });
    onEvent?.({ type: "RUN_FINISHED", runId: "run-1", outcome: {
      type: "interrupt", interrupts: [{ id: "old-interrupt", reason: "input_required", message: "请输入" }],
    } });
    expect(client.pendingInteractions.get()).toHaveLength(1);
    await client.connect();
    socket?.onmessage?.({ data: JSON.stringify({ type: "session.snapshot", session_id: "session-1", payload: {
      event_watermark: 12,
      runtime: { state: "idle", load_strategy: "history", allowed_actions: ["send_message", "start_maintenance"],
        active_run: null, last_run: null, pending_interactions: [], resume_interaction_id: null,
        maintenance: null, observed_at: "2026-10-10T00:00:00Z" },
      messages: { items: [], has_more: false, before_seq: null }, participants: [], pending_requests: [],
      execution: [], tree: { root: null },
    } }) });
    expect(client.pendingInteractions.get()).toEqual([]);
    onEvent?.({ type: "RUN_FINISHED", runId: "run-1", outcome: {
      type: "interrupt", interrupts: [{ id: "old-interrupt", reason: "input_required", message: "请输入" }],
    } });
    expect(client.pendingInteractions.get()).toEqual([]);
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
