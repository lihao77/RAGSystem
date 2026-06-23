import { describe, expect, it } from "vitest";

import { ClientToServerEnvelopeSchema, EnvelopeTypeSchema } from "../../src/contracts/events.js";

describe("envelope contract", () => {
  it("includes core protocol types", () => {
    expect(EnvelopeTypeSchema.safeParse("run_started").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("run_ended").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("agent_started").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("agent_ended").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("tool_call").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("tool_result").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("stream_output").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("interaction").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("state_sync").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("ack").success).toBe(true);
    expect(EnvelopeTypeSchema.safeParse("abort").success).toBe(true);
  });

  it("parses uplink user_driven_change", () => {
    expect(
      ClientToServerEnvelopeSchema.parse({
        type: "user_driven_change",
        session_id: "s1",
        payload: { category: "task_submit", task: "hi" },
      }),
    ).toMatchObject({
      type: "user_driven_change",
      session_id: "s1",
      payload: { category: "task_submit", task: "hi", attachments: [] },
    });
  });

  it("parses uplink interaction responded", () => {
    expect(
      ClientToServerEnvelopeSchema.parse({
        type: "interaction",
        session_id: "s1",
        call_id: "approval-1",
        payload: { kind: "approval", phase: "responded", approved: true, message: "ok" },
      }),
    ).toMatchObject({
      type: "interaction",
      call_id: "approval-1",
      payload: { kind: "approval", phase: "responded", approved: true },
    });
  });

  it("parses uplink abort", () => {
    expect(
      ClientToServerEnvelopeSchema.parse({
        type: "abort",
        session_id: "s1",
        payload: { scope: "run" },
      }),
    ).toMatchObject({ type: "abort", payload: { scope: "run" } });
  });
});
