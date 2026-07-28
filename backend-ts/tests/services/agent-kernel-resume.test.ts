import { describe, expect, it, vi } from "vitest";

import { RecoverableInterrupt } from "@ragsystem/agent-sdk";
import {
  AgentKernel,
  createHookRegistry,
  type KernelContext,
  type KernelObservation,
  type KernelToolCall,
  type RuntimeSession,
} from "@ragsystem/agent-sdk";

function createSession(conversation: RuntimeSession["conversation"]): RuntimeSession {
  const provider = {
    key: "test",
    provider_type: "openai",
  } as RuntimeSession["provider"];
  return {
    profile: {
      agentName: "test-agent",
      llmTiers: {
        default: {
          provider,
          modelName: "test-model",
          temperature: null,
          maxCompletionTokens: null,
          maxContextTokens: null,
          extraParams: {},
        },
      },
      behavior: {
        systemPrompt: "",
        compressionTriggerRatio: null,
        summarizeMaxTokens: null,
        preserveRecentTurns: null,
      },
    },
    provider,
    modelName: "test-model",
    conversation,
    sessionId: "session-1",
    runId: "run-1",
    taskId: null,
    requestId: null,
    rootCallId: "root-call",
    threadKey: "root",
    parentCallId: null,
  };
}

describe("AgentKernel 通用开始契约", () => {
  it("在上一轮工具结果之后、下一轮模型调用之前刷新 followup", async () => {
    const refresher = vi.fn(async (ctx: KernelContext, round: number) => {
      if (round === 0) return [];
      expect(ctx.messages).toContainEqual({
        role: "tool",
        content: "工具结果",
        tool_call_id: "call-1",
      });
      return [{ role: "user" as const, content: "补充说明" }];
    });
    const invoke = vi.fn(async (ctx: KernelContext, round: number) => {
      if (round === 0) {
        return {
          kind: "tool_calls" as const,
          calls: [{ index: 0, callId: "call-1", toolName: "lookup", arguments: {} }],
          assistantMessage: {
            role: "assistant" as const,
            content: "查一下",
            tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "lookup", arguments: "{}" } }],
          },
          finishReason: "tool_calls",
          usage: undefined,
        };
      }
      expect(ctx.messages).toMatchObject([
        { role: "assistant", content: "查一下" },
        { role: "tool", content: "工具结果", tool_call_id: "call-1" },
        { role: "user", content: "补充说明" },
      ]);
      return {
        kind: "final" as const,
        finalAnswer: "完成",
        assistantMessage: { role: "assistant" as const, content: "完成" },
        finishReason: "stop",
        usage: undefined,
      };
    });
    const kernel = new AgentKernel({
      context: { buildMessages: (ctx) => [...ctx.messages] },
      protocol: {
        buildRequest: () => { throw new Error("本测试不调用 buildRequest"); },
        invoke,
        renderObservations: (calls) => calls.map((call) => ({
          role: "tool" as const,
          content: "工具结果",
          tool_call_id: call.callId,
        })),
        toModelMessages: (messages) => messages,
      },
      tools: {
        executeRound: async (_ctx, _round, calls) => calls.map((call) => ({
          ...call,
          result: {
            success: true,
            toolName: call.toolName,
            summary: "ok",
            answer: null,
            outputType: "text" as const,
            content: "工具结果",
            metadata: {},
            artifacts: [],
            llmHint: null,
          },
          observation: "工具结果",
        })),
      },
      events: { emit: vi.fn() },
      refresher: { refresh: refresher },
      hooks: createHookRegistry(),
    });

    await expect(kernel.run(createSession([]))).resolves.toMatchObject({ content: "完成" });
    expect(refresher).toHaveBeenNthCalledWith(1, expect.anything(), 0);
    expect(refresher).toHaveBeenNthCalledWith(2, expect.anything(), 1);
  });

  it("先重执行未配对 tool_use，再携带 observation 进入 LLM", async () => {
    const executeRound = vi.fn(async (_ctx: KernelContext, _round: number, calls: KernelToolCall[]) => calls.map<KernelObservation>((call) => ({
      ...call,
      result: {
        success: true,
        toolName: call.toolName,
        summary: "ok",
        answer: null,
        outputType: "text",
        content: "恢复结果",
        metadata: {},
        artifacts: [],
        llmHint: null,
      },
      observation: "恢复结果",
    })));
    const invoke = vi.fn(async (ctx: KernelContext) => {
      expect(ctx.messages).toContainEqual({ role: "tool", content: "恢复结果", tool_call_id: "call-2" });
      expect(ctx.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      return {
        kind: "final" as const,
        finalAnswer: "完成",
        assistantMessage: { role: "assistant" as const, content: "完成" },
        finishReason: "stop",
        usage: undefined,
      };
    });
    const kernel = new AgentKernel({
      context: { buildMessages: (ctx) => [...ctx.messages] },
      protocol: {
        buildRequest: () => { throw new Error("本测试不调用 buildRequest"); },
        invoke,
        renderObservations: (calls, observations) => observations.map((observation, index) => ({
          role: "tool" as const,
          content: observation.observation,
          tool_call_id: calls[index]!.callId,
        })),
        toModelMessages: (messages) => messages,
      },
      tools: { executeRound },
      events: { emit: vi.fn() },
      refresher: { refresh: async () => [] },
      hooks: createHookRegistry(),
    });

    const result = await kernel.run(createSession([
      {
        role: "assistant",
        content: "已有工具调用",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "done", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "resume", arguments: "{\"value\":1}" } },
        ],
      },
      { role: "tool", content: "已完成", tool_call_id: "call-1" },
    ]));

    expect(executeRound).toHaveBeenCalledTimes(1);
    expect(executeRound).toHaveBeenCalledWith(expect.anything(), 0, [{
      index: 0,
      callId: "call-2",
      toolName: "resume",
      arguments: { value: 1 },
    }]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("完成");
  });

  it("RecoverableInterrupt 静默重抛且不发 error 事件", async () => {
    const events = { emit: vi.fn() };
    const interrupt = new RecoverableInterrupt({
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "call-1",
      kind: "approval",
    });
    const kernel = new AgentKernel({
      context: { buildMessages: (ctx) => [...ctx.messages] },
      protocol: {
        buildRequest: () => { throw new Error("本测试不调用 buildRequest"); },
        invoke: async () => { throw new Error("不应调用 LLM"); },
        renderObservations: () => [],
        toModelMessages: (messages) => messages,
      },
      tools: { executeRound: async () => { throw interrupt; } },
      events,
      refresher: { refresh: async () => [] },
      hooks: createHookRegistry(),
    });

    await expect(kernel.run(createSession([{
      role: "assistant",
      content: "等待审批",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "danger", arguments: "{}" } }],
    }]))).rejects.toBe(interrupt);
    expect(events.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});
