import { describe, expect, it, vi } from "vitest";

import { AguiSseClient } from "../src/agui.js";

function sseBody(...events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    },
  });
}

describe("AguiSseClient stream lifecycle", () => {
  it("rejects completion when EOF arrives before a terminal event", async () => {
    const client = new AguiSseClient({
      endpoint: "https://rag.example.test/api/agui",
      fetch: vi.fn(async () => new Response(sseBody(
        JSON.stringify({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
      ), { status: 200 })),
      resolveHeaders: async () => ({}),
    });
    const run = client.start({ threadId: "t-1", messages: [{ role: "user", content: "hello" }] });
    await expect(run.started).resolves.toMatchObject({ type: "RUN_STARTED" });
    await expect(run.completed).rejects.toThrow("终态事件前结束");
  });

  it("does not fail the stream when an event listener throws", async () => {
    const client = new AguiSseClient({
      endpoint: "https://rag.example.test/api/agui",
      fetch: vi.fn(async () => new Response(sseBody(
        JSON.stringify({ type: "RUN_STARTED", threadId: "t-1", runId: "r-1" }),
        JSON.stringify({ type: "RUN_FINISHED", threadId: "t-1", runId: "r-1", outcome: { type: "success" } }),
      ), { status: 200 })),
      resolveHeaders: async () => ({}),
      onEvent: () => { throw new Error("listener failed"); },
    });
    const run = client.start({ threadId: "t-1", messages: [{ role: "user", content: "hello" }] });
    await expect(run.started).resolves.toMatchObject({ type: "RUN_STARTED" });
    await expect(run.completed).resolves.toMatchObject({ type: "RUN_FINISHED" });
  });
});
