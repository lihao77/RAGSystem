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

  it("exposes event outbox diagnostics in system metrics", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.conversationStore.createSession("metrics-outbox");
    harness.container.conversationStore.appendOutbox({
      sessionId: "metrics-outbox",
      runId: "run-pending",
      eventId: "event-pending",
      eventType: "run.completed",
      aggregateType: "run",
      aggregateId: "run-pending",
      payload: {
        final_message_id: "msg-pending",
        metadata: { run_id: "run-pending" },
      },
    });
    const retrying = harness.container.conversationStore.appendOutbox({
      sessionId: "metrics-outbox",
      runId: "run-retrying",
      eventId: "event-retrying",
      eventType: "run.failed",
      aggregateType: "run",
      aggregateId: "run-retrying",
      payload: {
        status: "failed",
        error: "transient projection failure",
        metadata: { run_id: "run-retrying" },
      },
    });
    const failed = harness.container.conversationStore.appendOutbox({
      sessionId: "metrics-outbox",
      runId: "run-failed",
      eventId: "event-failed",
      eventType: "run.failed",
      aggregateType: "run",
      aggregateId: "run-failed",
      payload: {
        status: "failed",
        error: "projection failed",
        metadata: { run_id: "run-failed" },
      },
    });
    harness.container.conversationStore.markOutboxRetrying(
      retrying.id,
      "transient projection failure",
      "2999-01-01T00:00:00.000Z",
    );
    harness.container.conversationStore.markOutboxFailed(failed.id, "projection failed");

    const metrics = await app.inject({
      method: "GET",
      url: "/api/agent/metrics",
    });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().data.event_outbox).toMatchObject({
      delivery_mode: "outbox_live",
      dispatcher: {
        projected: 0,
        delivered: 0,
        failed: 0,
        lastError: null,
      },
      store: {
        total: 3,
        pending: 1,
        retrying: 1,
        delivered: 0,
        failed: 1,
        locked: 0,
        ready: 1,
        oldest_pending_created_at: expect.any(String),
        oldest_pending_age_seconds: expect.any(Number),
      },
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
          budget_tokens: 109104,
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
    const systemPrompt = snapshot.json().data.system_prompt as string;
    expect(systemPrompt).toContain("You are RAGSystem");
    expect(systemPrompt).toContain("## 可直接调用的工具");
    expect(systemPrompt).toContain("request_user_input");
    expect(systemPrompt).toContain("## 子 Agent 委派");
    expect(systemPrompt).toContain("call_agent");
    expect(systemPrompt).toContain("## 输出格式");
    expect(systemPrompt).toContain("## 执行规则");
    expect(systemPrompt).toContain("### 数据文件传递规则");

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

  it("serves context snapshot history through the compression view for the root thread", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "compression-s1" });
    harness.container.sessionApplication.addMessage({
      sessionId: "compression-s1",
      role: "user",
      content: "old user",
    });
    harness.container.sessionApplication.addMessage({
      sessionId: "compression-s1",
      role: "assistant",
      content: "old assistant",
    });
    const tailBeforeSummary = harness.container.sessionApplication.addMessage({
      sessionId: "compression-s1",
      role: "user",
      content: "tail before summary",
    });
    const summary = harness.container.sessionApplication.addMessage({
      sessionId: "compression-s1",
      role: "system",
      content: "[历史摘要]\nold user / old assistant",
      metadata: {
        compression: true,
        replaces_up_to_seq: 2,
      },
    });
    const tailAfterSummary = harness.container.sessionApplication.addMessage({
      sessionId: "compression-s1",
      role: "assistant",
      content: "tail after summary",
    });
    harness.container.sessionApplication.addMessage({
      sessionId: "compression-s1",
      role: "user",
      content: "child internal message",
      threadKey: "child:worker",
      childAgentId: "child-1",
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/agent/context-snapshot?session_id=compression-s1",
    });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().data.conversation_history).toEqual([
      expect.objectContaining({
        seq: summary.seq,
        role: "assistant",
        content_preview: "[历史摘要]\nold user / old assistant",
        is_compression_summary: true,
      }),
      expect.objectContaining({
        seq: tailBeforeSummary.seq,
        role: "user",
        content_preview: "tail before summary",
      }),
      expect.objectContaining({
        seq: tailAfterSummary.seq,
        role: "assistant",
        content_preview: "tail after summary",
      }),
    ]);
  });

  it("serves context snapshot history from persisted ReAct intermediate messages only", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.sessionApplication.createSession({ sessionId: "react-runsteps-only" });
    const runStepsOnlyUser = harness.container.sessionApplication.addMessage({
      sessionId: "react-runsteps-only",
      role: "user",
      content: "测试工具是否能运行",
      metadata: { run_id: "run-1" },
    });
    const runStepsOnlyAssistant = harness.container.sessionApplication.addMessage({
      sessionId: "react-runsteps-only",
      role: "assistant",
      content: "工具测试完成",
      metadata: { run_id: "run-1" },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "react-runsteps-only",
      runId: "run-1",
      messageId: runStepsOnlyAssistant.id,
      stepType: "execution.step",
      payload: {
        kind: "intent",
        phase: "complete",
        content: "我先执行一个只读命令。",
        round: 0,
      },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "react-runsteps-only",
      runId: "run-1",
      messageId: runStepsOnlyAssistant.id,
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "start",
        call_id: "call-1",
        tool_name: "execute_bash",
        arguments: { command: "pwd" },
        round: 0,
      },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "react-runsteps-only",
      runId: "run-1",
      messageId: runStepsOnlyAssistant.id,
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "end",
        call_id: "call-1",
        tool_name: "execute_bash",
        observation: "[execute_bash]\n命令执行完成，返回码 0",
      },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "react-runsteps-only",
      runId: "run-1",
      messageId: runStepsOnlyAssistant.id,
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "start",
        call_id: "call-2",
        tool_name: "task_list",
        arguments: {},
        round: 0,
      },
    });
    harness.container.conversationStore.addRunStep({
      sessionId: "react-runsteps-only",
      runId: "run-1",
      messageId: runStepsOnlyAssistant.id,
      stepType: "execution.step",
      payload: {
        kind: "tool",
        phase: "end",
        call_id: "call-2",
        tool_name: "task_list",
        observation: "[task_list]\n共 0 个任务",
      },
    });

    const runStepsOnlySnapshot = await app.inject({
      method: "GET",
      url: "/api/agent/context-snapshot?session_id=react-runsteps-only",
    });
    expect(runStepsOnlySnapshot.statusCode).toBe(200);
    expect(runStepsOnlySnapshot.json().data.conversation_history).toEqual([
      expect.objectContaining({
        seq: runStepsOnlyUser.seq,
        role: "user",
        content_preview: "测试工具是否能运行",
        react_intermediate: false,
        msg_type: null,
      }),
      expect.objectContaining({
        seq: runStepsOnlyAssistant.seq,
        role: "assistant",
        content_preview: "工具测试完成",
        react_intermediate: false,
        msg_type: null,
      }),
    ]);

    harness.container.sessionApplication.createSession({ sessionId: "react-persisted" });
    const user = harness.container.sessionApplication.addMessage({
      sessionId: "react-persisted",
      role: "user",
      content: "测试工具是否能运行",
      metadata: { run_id: "run-2" },
    });
    const intent = harness.container.sessionApplication.addMessage({
      sessionId: "react-persisted",
      role: "assistant",
      content:
        "我先执行一个只读命令。\n\n<tool_calls>\n<tool name=\"execute_bash\"><command>pwd</command></tool>\n<tool name=\"task_list\"></tool>\n</tool_calls>",
      metadata: {
        react_intermediate: true,
        msg_type: "intent",
        round: 1,
        run_id: "run-2",
      },
    });
    const observation = harness.container.sessionApplication.addMessage({
      sessionId: "react-persisted",
      role: "user",
      content:
        '<tool_result id="call-1" name="execute_bash" ok="true"><![CDATA[命令执行完成，返回码 0]]></tool_result>\n\n<tool_result id="call-2" name="task_list" ok="true"><![CDATA[共 0 个任务]]></tool_result>',
      metadata: {
        react_intermediate: true,
        msg_type: "observation",
        round: 1,
        run_id: "run-2",
      },
    });
    const assistant = harness.container.sessionApplication.addMessage({
      sessionId: "react-persisted",
      role: "assistant",
      content: "工具测试完成",
      metadata: { run_id: "run-2" },
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/agent/context-snapshot?session_id=react-persisted",
    });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().data.conversation_history).toEqual([
      expect.objectContaining({
        seq: user.seq,
        role: "user",
        content_preview: "测试工具是否能运行",
        react_intermediate: false,
        msg_type: null,
      }),
      expect.objectContaining({
        seq: intent.seq,
        role: "assistant",
        content_preview:
          "我先执行一个只读命令。\n\n<tool_calls>\n<tool name=\"execute_bash\"><command>pwd</command></tool>\n<tool name=\"task_list\"></tool>\n</tool_calls>",
        can_load_full_content: true,
        react_intermediate: true,
        msg_type: "intent",
        round: 1,
      }),
      expect.objectContaining({
        seq: observation.seq,
        role: "user",
        content_preview: expect.stringContaining("<tool_result"),
        can_load_full_content: true,
        react_intermediate: true,
        msg_type: "observation",
        round: 1,
      }),
      expect.objectContaining({
        seq: assistant.seq,
        role: "assistant",
        content_preview: "工具测试完成",
        react_intermediate: false,
        msg_type: null,
      }),
    ]);
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
