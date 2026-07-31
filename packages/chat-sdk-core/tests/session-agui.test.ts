import { describe, expect, it, vi } from "vitest";

import { SessionAgentClient } from "../src/session-client.js";

describe("SessionAgentClient AG-UI fallback", () => {
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
});
