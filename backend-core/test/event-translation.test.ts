import { describe, expect, it } from "vitest";

import { translateKernelEvent } from "../src/services/agent/sdk/event-translation.js";

describe("kernel event wire translation", () => {
  it("projects model_request as an explicit root model lifecycle event", () => {
    const events = translateKernelEvent(
      { type: "model_request", agentName: "agent", round: 3 },
      {
        sessionId: "session-1",
        runId: "run-1",
        rootCallId: "root-call",
        requestId: "request-1",
        agentId: "agent",
      },
    );

    expect(events).toEqual([{
      type: "model_request",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
      payload: { phase: "start", round: 3 },
    }]);
  });
});
