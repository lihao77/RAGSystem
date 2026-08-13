import { describe, expect, it } from "vitest";

import type { Envelope } from "../src/contracts/events.js";
import { executionEnvelopeMessageBoundary } from "../src/contracts/storage/run-step-boundary.js";
import { buildExecutionEnvelopeRunStep } from "../src/services/runtime/event-outbox/execution-envelope-archive.js";

describe("execution envelope message boundaries", () => {
  it("uses boundary_message_id only as a live presentation target", () => {
    const envelope = {
      type: "model_request",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "call-1",
      agent_id: "agent-1",
      boundary_message_id: "user-1",
      payload: { phase: "start", round: 0 },
    } satisfies Envelope;

    expect(executionEnvelopeMessageBoundary(envelope)).toEqual({});
    expect(buildExecutionEnvelopeRunStep("session-1", "run-1", envelope, "event-1"))
      .not.toHaveProperty("boundaryMessageId");
  });

  it("creates a carrier boundary only for a canonical agent message", () => {
    const envelope = {
      type: "agent_message",
      session_id: "session-1",
      run_id: "run-1",
      message_id: "followup-1",
      boundary_message_id: "previous-user",
      payload: {
        kind: "request",
        message_id: "followup-1",
        content: "continue",
      },
    } satisfies Envelope;

    expect(executionEnvelopeMessageBoundary(envelope)).toEqual({
      boundaryMessageId: "followup-1",
      boundaryKind: "carrier",
    });
  });

  it("creates a terminal boundary for the final assistant message", () => {
    const envelope = {
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      message_id: "assistant-1",
      call_id: "call-1",
      agent_id: "agent-1",
      payload: { phase: "final", content: "done" },
    } satisfies Envelope;

    expect(executionEnvelopeMessageBoundary(envelope)).toEqual({
      boundaryMessageId: "assistant-1",
      boundaryKind: "terminal",
    });
  });
});
