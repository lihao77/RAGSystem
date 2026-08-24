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

  it("stamps the current boundary on tool envelopes so interjections cannot split call/result routing", () => {
    // 插嘴认领后 boundary 翻转：工具 call/result 同 boundary 精确路由，
    // 前端不再依赖消息列表位置回退（splice/重排会拆散配对 → 工具永远 running）。
    const boundaryContext = { ...context, boundaryMessageId: "u2" };
    const [toolCall] = translateKernelEvent({
      type: "tool_call",
      agentName: "agent",
      toolCallId: "tool-1",
      toolName: "read",
      arguments: {},
      round: 1,
      order: 0,
      roundIndex: 0,
    }, boundaryContext);
    expect(toolCall?.boundary_message_id).toBe("u2");

    const [toolResult] = translateKernelEvent({
      type: "tool_result",
      agentName: "agent",
      toolCallId: "tool-1",
      toolName: "read",
      success: true,
      summary: "ok",
      observation: "ok",
      metadata: {},
      referenceResult: {},
      elapsedTime: 0,
      round: 1,
      order: 0,
      roundIndex: 0,
    }, boundaryContext);
    expect(toolResult?.boundary_message_id).toBe("u2");

    // 无 boundary（子线程/历史合成）时不带该字段，协议顶层可选。
    const [plain] = translateKernelEvent({
      type: "tool_call",
      agentName: "agent",
      toolCallId: "tool-2",
      toolName: "read",
      arguments: {},
      round: 0,
      order: 0,
      roundIndex: 0,
    }, context);
    expect(plain).not.toHaveProperty("boundary_message_id");
  });

  it("maps terminal-closed tool results to interrupted status on the wire", () => {
    const [event] = translateKernelEvent({
      type: "tool_result",
      agentName: "agent",
      toolCallId: "tool-9",
      toolName: "read",
      success: false,
      summary: "",
      observation: "工具执行被中断",
      metadata: { terminal_status: "interrupted" },
      referenceResult: {},
      elapsedTime: 0,
      round: 0,
      order: 0,
      roundIndex: 0,
    }, context);
    expect(event?.payload).toMatchObject({ ok: false, status: "interrupted" });
  });

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

  it("projects reasoning stream events with round lineage like intent", () => {
    const childContext = {
      sessionId: "session-1",
      runId: "run-1",
      rootCallId: "root-call",
      requestId: "request-1",
      agentId: "agent",
      parentCallId: "parent-call",
    };
    const [delta] = translateKernelEvent({
      type: "reasoning_delta",
      agentName: "agent",
      content: "think ",
      round: 2,
    }, childContext);
    expect(delta).toMatchObject({
      type: "stream_output",
      session_id: "session-1",
      run_id: "run-1",
      call_id: "root-call",
      agent_id: "agent",
    });
    expect(delta?.payload).toEqual({
      phase: "reasoning_delta",
      content: "think ",
      round: 2,
      lineage: { parent_call_id: "parent-call" },
    });

    const [complete] = translateKernelEvent({
      type: "reasoning_complete",
      agentName: "agent",
      content: "think twice",
      round: 2,
    }, context);
    expect(complete?.payload).toEqual({
      phase: "reasoning_complete",
      content: "think twice",
      round: 2,
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

  it("projects the structured rawResult onto raw_result with a size guard", () => {
    const context = {
      sessionId: "session-1",
      runId: "run-1",
      rootCallId: "root-call",
      requestId: "request-1",
      agentId: "agent",
    };
    const rawResult = {
      success: true,
      tool_name: "execute_bash",
      summary: "done",
      content: { stdout: "ok", stderr: "", return_code: 0 },
      metadata: {},
    };
    const base = {
      type: "tool_result" as const,
      agentName: "agent",
      toolCallId: "tool-raw",
      toolName: "execute_bash",
      success: true,
      summary: "done",
      observation: "rendered",
      metadata: {},
      referenceResult: {},
      elapsedTime: 0.1,
      round: 0,
      order: 0,
      roundIndex: 0,
    };

    const [withRaw] = translateKernelEvent({ ...base, rawResult }, context);
    expect((withRaw?.payload as Record<string, unknown>).raw_result).toEqual(rawResult);

    const oversized = { ...rawResult, content: { stdout: "x".repeat(80 * 1024) } };
    const [dropped] = translateKernelEvent({ ...base, rawResult: oversized }, context);
    expect((dropped?.payload as Record<string, unknown>).raw_result).toBeUndefined();

    const [legacy] = translateKernelEvent(base, context);
    expect((legacy?.payload as Record<string, unknown>).raw_result).toBeUndefined();
  });
});
