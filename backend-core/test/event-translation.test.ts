import { describe, expect, it } from "vitest";

import { translateKernelEvent } from "../src/services/agent/sdk/event-translation.js";

describe("kernel event wire translation", () => {
  const context = {
    sessionId: "session-1",
    runId: "run-1",
    rootCallId: "root-call",
    requestId: "request-1",
    agentId: "agent",
  };

  it("projects ordered text and file content parts", () => {
    expect(translateKernelEvent({
      type: "output_delta",
      agentName: "agent",
      content: "Map: ",
      partIndex: 0,
    }, context)[0]?.payload).toMatchObject({ phase: "delta", content: "Map: ", part_index: 0 });

    expect(translateKernelEvent({
      type: "output_file_ref",
      agentName: "agent",
      partIndex: 1,
      part: {
        type: "file_ref",
        filePath: "results/map.png",
        presentation: "inline",
      },
    }, context)[0]?.payload).toMatchObject({
      phase: "part_added",
      part_index: 1,
      part: { type: "file_ref", file_path: "results/map.png", presentation: "inline" },
    });
  });

  it("projects tool files onto the wire result", () => {
    const [event] = translateKernelEvent({
      type: "tool_result",
      agentName: "agent",
      toolCallId: "tool-1",
      toolName: "execute_skill_script",
      success: true,
      summary: "done",
      observation: "done",
      metadata: {},
      referenceResult: {
        files: [{
          fileType: "image",
          path: "results/map.png",
          mimeType: "image/png",
          size: 128,
          metadata: { lifecycle: "workspace" },
        }],
      },
      elapsedTime: 0.1,
      round: 0,
      order: 0,
      roundIndex: 0,
    }, context);

    expect(event?.payload).toMatchObject({ files: [{ path: "results/map.png", media_type: "image/png" }] });
  });

  it("projects explicit agent operation metadata onto the wire result", () => {
    const [event] = translateKernelEvent({
      type: "tool_result",
      agentName: "agent",
      toolCallId: "tool-agent",
      toolName: "agent",
      success: true,
      summary: "queued",
      observation: "queued",
      metadata: {
        agent_operation: {
          type: "message_parent",
          message_id: "message-1",
          message_kind: "response",
          delivery_status: "queued",
        },
      },
      referenceResult: {},
      elapsedTime: 0.1,
      round: 0,
      order: 0,
      roundIndex: 0,
    }, context);

    expect(event?.payload).toMatchObject({
      agent_operation: {
        type: "message_parent",
        message_id: "message-1",
        message_kind: "response",
        delivery_status: "queued",
      },
    });
  });

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

  it("marks provider-reported context usage separately from estimates", () => {
    const events = translateKernelEvent({
      type: "context_usage",
      agentName: "agent",
      round: 2,
      source: "provider",
      systemPromptTokens: 200,
      historyTokens: 800,
      totalTokens: 1000,
      budgetTokens: 4000,
      compressing: false,
    }, {
      sessionId: "session-1",
      runId: "run-1",
      rootCallId: "root-call",
      requestId: "request-1",
      agentId: "agent",
    });

    expect(events[0]?.payload).toMatchObject({
      category: "context_usage",
      detail: {
        used_tokens: 1000,
        budget_tokens: 4000,
        token_source: "provider",
      },
    });
  });
});
