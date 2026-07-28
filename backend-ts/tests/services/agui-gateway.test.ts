import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";

import type { ExecutionApplication } from "../../src/contracts/execution/execution-application.js";
import type { RuntimeContainer } from "../../src/contracts/runtime/runtime-container.js";
import type { InteractionCoordinator } from "../../src/contracts/runtime/pending-interactions.js";
import type { UserId } from "../../src/identity/types.js";
import { AguiGateway } from "../../src/services/agui-gateway/agui-handler.js";
import { InterruptMachine } from "../../src/services/agui-gateway/interrupt-machine.js";
import type { Envelope } from "../../src/contracts/events.js";

describe("AguiGateway", () => {
  it("can resume an interrupt through a new request-scoped gateway", async () => {
    const machine = new InterruptMachine();
    machine.record({
      aguiInterruptId: "interrupt-1",
      internalRunId: "internal-1",
      threadId: "thread-1",
      callId: "approval-1",
      kind: "approval",
      interrupt: { id: "interrupt-1", reason: "confirmation" },
    });
    const chunks: string[] = [];
    const raw = {
      destroyed: false, writableEnded: false, writeHead: vi.fn(), flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
      end: vi.fn(),
    };
    const reply = { hijack: vi.fn(), getHeaders: vi.fn(() => ({})), raw, request: { raw: new EventEmitter() } } as unknown as FastifyReply;
    const container = { realtimeEvents: { subscribe: vi.fn(() => vi.fn()) }, hostToolRegistry: { register: vi.fn() } } as unknown as RuntimeContainer;
    const interactions = { respondApprovalAsync: vi.fn(async () => ({ resolved: true })) } as unknown as InteractionCoordinator;
    const gateway = new AguiGateway(container, "usr_test" as UserId, {} as ExecutionApplication, interactions, machine);

    await gateway.handle({ threadId: "thread-1", runId: "resume-1", resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { approved: true } }] }, reply);

    const events = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length).trim()) as { type: string; name?: string; value?: unknown });
    expect(events).toEqual([
      expect.objectContaining({ type: "RUN_STARTED" }),
      expect.objectContaining({ type: "CUSTOM", name: "interrupt.resolved", value: { interruptId: "interrupt-1", status: "resolved" } }),
    ]);
    expect(interactions.respondApprovalAsync).toHaveBeenCalledWith("thread-1", "approval-1", { approved: true, message: "" });
    expect(machine.peek("interrupt-1")).toBeNull();
  });

  it("returns RUN_ERROR and keeps the interrupt retryable when approval submission fails", async () => {
    const machine = new InterruptMachine();
    const record = {
      aguiInterruptId: "interrupt-failed",
      internalRunId: "internal-failed",
      threadId: "thread-failed",
      callId: "approval-failed",
      kind: "approval" as const,
      interrupt: { id: "interrupt-failed", reason: "confirmation" },
    };
    machine.record(record);
    const chunks: string[] = [];
    const raw = {
      destroyed: false, writableEnded: false, writeHead: vi.fn(), flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }), end: vi.fn(),
    };
    const reply = { hijack: vi.fn(), getHeaders: vi.fn(() => ({})), raw, request: { raw: new EventEmitter() } } as unknown as FastifyReply;
    const container = { realtimeEvents: { subscribe: vi.fn(() => vi.fn()) }, hostToolRegistry: { register: vi.fn() } } as unknown as RuntimeContainer;
    const interactions = { respondApprovalAsync: vi.fn(async () => ({ resolved: false })) } as unknown as InteractionCoordinator;
    const gateway = new AguiGateway(container, "usr_test" as UserId, {} as ExecutionApplication, interactions, machine);

    await gateway.handle({ threadId: "thread-failed", runId: "resume-failed", resume: [{ interruptId: "interrupt-failed", status: "resolved", payload: { approved: true } }] }, reply);

    const events = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length).trim()) as { type: string; message?: string });
    expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    expect(events[1]?.message).toBe("审批请求已失效或不存在");
    expect(machine.peek("interrupt-failed")).toEqual(record);
  });

  it("returns the next pending approval when the current batch is not ready to resume", async () => {
    const machine = new InterruptMachine();
    machine.record({
      aguiInterruptId: "interrupt-1",
      internalRunId: "internal-1",
      threadId: "thread-1",
      callId: "approval-1",
      kind: "approval",
      interrupt: { id: "interrupt-1", reason: "confirmation" },
    });
    const chunks: string[] = [];
    const raw = {
      destroyed: false, writableEnded: false, writeHead: vi.fn(), flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }), end: vi.fn(),
    };
    const reply = { hijack: vi.fn(), getHeaders: vi.fn(() => ({})), raw, request: { raw: new EventEmitter() } } as unknown as FastifyReply;
    const unsubscribe = vi.fn();
    const container = { realtimeEvents: { subscribe: vi.fn(() => unsubscribe) }, hostToolRegistry: { register: vi.fn() } } as unknown as RuntimeContainer;
    const interactions = {
      respondApprovalAsync: vi.fn(async () => ({
        resolved: true,
        needsResume: false,
        kind: "approval" as const,
        interactionId: "approval-1",
        rootRunId: "internal-1",
        resumeDisposition: "none" as const,
      })),
      listPendingAsync: vi.fn(async () => [{
        approvalId: "approval-2",
        sessionId: "thread-1",
        toolCallId: "tool-2",
        rootRunId: "internal-1",
        runId: "internal-1",
        kind: "approval" as const,
        batchId: "batch-1",
        resolved: false,
        task: "test",
        requestId: null,
        toolName: "write_file",
        prompt: "批准第二项操作",
      }]),
    } as unknown as InteractionCoordinator;
    const gateway = new AguiGateway(container, "usr_test" as UserId, {} as ExecutionApplication, interactions, machine);

    await gateway.handle({ threadId: "thread-1", runId: "resume-1", resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { approved: true } }] }, reply);

    const events = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length).trim()) as {
      type: string;
      name?: string;
      outcome?: { type?: string; interrupts?: Array<{ id: string; message?: string }> };
    });
    expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "CUSTOM", "RUN_FINISHED"]);
    expect(events[1]).toMatchObject({ name: "interrupt.resolved" });
    expect(events[2]?.outcome).toMatchObject({
      type: "interrupt",
      interrupts: [expect.objectContaining({ message: "批准第二项操作" })],
    });
    const nextInterruptId = events[2]?.outcome?.interrupts?.[0]?.id;
    expect(nextInterruptId).toBeTruthy();
    expect(machine.peek(nextInterruptId!)).toMatchObject({ callId: "approval-2", internalRunId: "internal-1" });
    expect(interactions.listPendingAsync).toHaveBeenCalledWith("internal-1", "thread-1");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("adapts a shared-entry slash command into a completed AG-UI text run", async () => {
    const chunks: string[] = [];
    const requestRaw = new EventEmitter();
    const raw = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
      end: vi.fn(() => { raw.writableEnded = true; }),
    };
    const reply = {
      hijack: vi.fn(),
      getHeaders: vi.fn(() => ({})),
      raw,
      request: { raw: requestRaw },
    } as unknown as FastifyReply;
    const unsubscribe = vi.fn();
    const container = {
      realtimeEvents: { subscribe: vi.fn(() => unsubscribe) },
      hostToolRegistry: { register: vi.fn() },
    } as unknown as RuntimeContainer;
    const execution = {
      startStream: vi.fn(async () => ({
        started: true,
        session_id: "thread-1",
        kind: "command" as const,
        command_result: { success: true, content: "available commands" },
      })),
    } as unknown as ExecutionApplication;
    const gateway = new AguiGateway(
      container,
      "usr_test" as UserId,
      execution,
      {} as InteractionCoordinator,
    );

    await gateway.handle({
      threadId: "thread-1",
      runId: "external-run-1",
      messages: [{ role: "user", content: "/help" }],
    }, reply);

    const events = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length).trim()) as { type: string; delta?: string });
    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[2]?.delta).toBe("available commands");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it("buffers terminal envelopes emitted before startStream returns the internal run id", async () => {
    const chunks: string[] = [];
    const requestRaw = new EventEmitter();
    const raw = {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
      end: vi.fn(() => { raw.writableEnded = true; }),
    };
    const reply = { hijack: vi.fn(), getHeaders: vi.fn(() => ({})), raw, request: { raw: requestRaw } } as unknown as FastifyReply;
    let listener: ((event: Envelope) => void) | null = null;
    const unsubscribe = vi.fn();
    const container = {
      realtimeEvents: {
        subscribe: vi.fn((_sessionId: string, callback: (event: Envelope) => void) => {
          listener = callback;
          return unsubscribe;
        }),
      },
      hostToolRegistry: { register: vi.fn() },
    } as unknown as RuntimeContainer;
    const execution = {
      startStream: vi.fn(async () => {
        listener?.({ type: "run_started", session_id: "thread-1", run_id: "internal-run-1", payload: {} } as Envelope);
        listener?.({ type: "run_ended", session_id: "thread-1", run_id: "internal-run-1", payload: { status: "completed" } } as Envelope);
        return { started: true, session_id: "thread-1", run_id: "internal-run-1", kind: "agent_run" as const };
      }),
    } as unknown as ExecutionApplication;
    const gateway = new AguiGateway(container, "usr_test" as UserId, execution, {} as InteractionCoordinator);

    await gateway.handle({
      threadId: "thread-1",
      runId: "external-run-1",
      messages: [{ role: "user", content: "hello" }],
    }, reply);

    const events = chunks.map((chunk) => JSON.parse(chunk.slice("data: ".length).trim()) as { type: string });
    expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(raw.end).toHaveBeenCalledOnce();
  });
});
