import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("monitoring compatibility routes", () => {
  it("returns empty system metrics and accepts metrics reset", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    const metrics = await app.inject({
      method: "GET",
      url: "/api/agent/metrics",
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({
      success: true,
      message: "获取系统指标成功",
      data: {
        total_agents: 0,
        total_calls: 0,
        avg_duration_ms: 0,
        overall_success_rate: 0,
        waiting: {
          total_waits: 0,
          total_completed: 0,
          total_timeouts: 0,
          total_keepalive_rounds: 0,
        },
        agents: {},
      },
    });

    const reset = await app.inject({
      method: "POST",
      url: "/api/agent/metrics/reset",
      payload: { agent_name: "general_agent" },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      success: true,
      message: "已重置智能体 general_agent指标",
    });
  });

  it("serves a Python-compatible context snapshot and persisted message content", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "s1" });
    const systemMessage = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "system",
      content: "S".repeat(300),
    });
    const message = harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "user",
      content: "U".repeat(300),
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/agent/context-snapshot?session_id=s1",
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      success: true,
      message: "获取上下文快照成功",
      data: {
        system_prompt: expect.stringContaining("系统默认主编排器"),
        available_agent_tools: expect.arrayContaining([
          expect.objectContaining({
            name: "general_agent",
          }),
        ]),
        available_tools: expect.arrayContaining([
          expect.objectContaining({
            name: "request_user_input",
          }),
          expect.objectContaining({
            name: "list_memory_index",
          }),
        ]),
        token_stats: {
          system_prompt_tokens: expect.any(Number),
          history_tokens: expect.any(Number),
          total_tokens: expect.any(Number),
          budget_tokens: 128000,
        },
        config: {
          agent_name: "orchestrator_agent",
          runtime: {
            execution_runtime: "ts",
            context_snapshot: "ts_compat",
          },
        },
        conversation_history: [
          expect.objectContaining({
            seq: systemMessage.seq,
            role: "system",
            content_preview: "S".repeat(300),
            is_preview_truncated: false,
            can_load_full_content: false,
          }),
          expect.objectContaining({
            seq: message.seq,
            role: "user",
            content_preview: `${"U".repeat(200)}...`,
            is_preview_truncated: true,
            can_load_full_content: true,
          }),
        ],
      },
    });

    const content = await app.inject({
      method: "GET",
      url: `/api/agent/context-snapshot/message-content?session_id=s1&seq=${message.seq}`,
    });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toMatchObject({
      success: true,
      message: "获取消息完整内容成功",
      data: {
        id: message.id,
        seq: message.seq,
        role: "user",
        content: "U".repeat(300),
        content_length: 300,
      },
    });
  });

  it("returns persisted tool call raw results by call id", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "s1" });
    harness.container.conversationStore.addRunStep({
      sessionId: "s1",
      runId: "run-1",
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "end",
        call_id: "call-1",
        tool_name: "execute_bash",
        result_preview: "ok",
        raw_result: { stdout: "hello" },
        raw_result_available: true,
      },
    });

    const raw = await app.inject({
      method: "GET",
      url: "/api/agent/tool-call/raw-result?session_id=s1&call_id=call-1",
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.json()).toMatchObject({
      success: true,
      message: "获取工具调用原始结果成功",
      data: {
        run_id: "run-1",
        session_id: "s1",
        tool_name: "execute_bash",
        result_preview: "ok",
        raw_result: { stdout: "hello" },
        raw_result_available: true,
      },
    });
  });
});
