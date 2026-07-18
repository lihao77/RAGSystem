import { describe, expect, it } from "vitest";
import type { AppendOutboxInput, OutboxRow } from "../../src/contracts/conversation-store/index.js";
import { AsyncDurableClientEventPublisher } from "../../src/services/runtime/event-outbox/async-client-event-publisher.js";

describe("AsyncDurableClientEventPublisher", () => {
  it("records then dispatches a durable client event", async () => {
    let input: AppendOutboxInput | null = null;
    const row = { id: 1, event_id: "e", session_id: "s", tenant_id: "t", run_id: "r", session_seq: 1, event_type: "client.run_ended", aggregate_type: "run", aggregate_id: "r", payload: "{}", status: "pending", attempts: 0, available_at: null, locked_at: null, delivered_at: null, last_error: null, created_at: new Date().toISOString() } satisfies OutboxRow;
    const delivered: number[] = [];
    const publisher = new AsyncDurableClientEventPublisher(
      { appendOutbox: async (value) => { input = value; return row; } },
      { dispatchRows: async (rows) => { delivered.push(...rows.map((item) => item.id)); return []; } },
    );
    await publisher.publish("s", { type: "run_ended", session_id: "s", run_id: "r" });
    expect(input).toMatchObject({ sessionId: "s", runId: "r", eventType: "client.run_ended" });
    expect(delivered).toEqual([1]);
  });
});
