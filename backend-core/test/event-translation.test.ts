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

  it("projects physical model attempts with retry truth", () => {
    const context = {
      sessionId: "session-1",
      runId: "run-1",
      rootCallId: "root-call",
      requestId: "request-1",
      agentId: "agent",
    };
    expect(translateKernelEvent({
      type: "model_attempt_failed",
      agentName: "agent",
      round: 3,
      attemptId: "attempt-1",
      attempt: 1,
      maxAttempts: 3,
      provider: "OpenAI",
      model: "gpt-test",
      willRetry: true,
      retryDelayMs: 750,
      elapsedMs: 120,
      error: "overloaded",
    }, context)).toEqual([{
      type: "model_attempt_failed",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
      payload: {
        phase: "failed",
        attempt_id: "attempt-1",
        attempt: 1,
        max_attempts: 3,
        round: 3,
        provider: "OpenAI",
        model: "gpt-test",
        will_retry: true,
        retry_delay_ms: 750,
        elapsed_ms: 120,
        error: "overloaded",
      },
    }]);
  });
});
