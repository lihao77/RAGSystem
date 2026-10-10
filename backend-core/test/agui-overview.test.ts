import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AguiGateway } from "../src/services/agui-gateway/agui-handler.js";
import { InterruptMachine } from "../src/services/agui-gateway/interrupt-machine.js";
import type { Envelope } from "../src/contracts/events.js";

describe("AG-UI session overview notifications", () => {
  it.each(["start", "reconnect", "resume"])("delivers session facts through %s without accepting another run's output", async (mode) => {
    let receive: ((event: Envelope) => void) | undefined;
    const sendGoal = () => receive?.({ type: "state_sync", session_id: "session-1", seq: 1,
      payload: { category: "session_updated", detail: { entity: "goal" } } });
    const unsubscribe = vi.fn();
    const runtime = { active_run: { run_id: "internal-run" }, pending_interactions: [] };
    let reads = 0;
    const container = {
      realtimeEvents: { subscribe: (_session: string, callback: typeof receive) => {
        receive = callback; return unsubscribe;
      } },
      sessionRuntime: { getSnapshot: async () => { if (reads++ === 0) sendGoal(); return runtime; } },
      agentExecution: { emitRunStreamSnapshot: async () => {} },
      delegationPending: { resolve: () => { sendGoal(); return true; } },
    };
    const execution = { startStream: async () => {
      sendGoal(); return { started: true, run_id: "internal-run" };
    } };
    const machine = new InterruptMachine();
    machine.record({ threadId: "session-1", aguiInterruptId: "interrupt-1", callId: "tool-1",
      kind: "delegate", internalRunId: "internal-run", interrupt: { id: "interrupt-1", reason: "tool_call" } });
    const gateway = new AguiGateway(container as never, "user-1" as never, execution as never,
      { listOutboxForReplay: async () => [] } as never, {} as never, machine);
    const chunks: string[] = [];
    const raw = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, writeHead: vi.fn(), flushHeaders: vi.fn(),
      write: (chunk: string) => { chunks.push(chunk); }, end: vi.fn(),
    });
    const reply = { getHeaders: () => ({}), hijack: vi.fn(), raw };
    await gateway.handle({ threadId: "session-1", runId: "external-run",
      ...(mode === "start" ? { messages: [{ role: "user", content: "task" }] }
        : mode === "reconnect" ? { reconnect: { runId: "internal-run" } }
          : { resume: [{ interruptId: "interrupt-1", status: "resolved", payload: { ok: true } }] }),
    } as never, reply as never);
    receive?.({ type: "state_sync", session_id: "session-1", seq: 2,
      payload: { category: "session_updated", detail: { entity: "background_task", task: { task_id: "task-1" } } } });
    receive?.({ type: "stream_output", session_id: "session-1", run_id: "another-run", seq: 3,
      payload: { phase: "delta", content: "must not leak" } });
    const events = chunks.map(chunk => JSON.parse(chunk.replace(/^data: /, "").trim()));
    expect(events.filter(event => event.name === "session_updated").map(event => event.value.detail.entity))
      .toEqual(["goal", "background_task"]);
    expect(chunks.join("")).not.toContain("must not leak");
    expect(raw.end).not.toHaveBeenCalled();
    raw.emit("close");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
