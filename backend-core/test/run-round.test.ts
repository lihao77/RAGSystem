import { describe, expect, it } from "vitest";
import {
  AgentKernel,
  createHookRegistry,
  type Context,
  type EventSink,
  type KernelObservation,
  type KernelToolCall,
  type Protocol,
  type RuntimeSession,
  type ToolProvider,
} from "@ragsystem/agent-sdk";

import { MSG_TYPE } from "../src/contracts/message-kinds.js";
import { resolveResumeToolResults, resolveRunStartRound } from "../src/services/agent/sdk/run-round.js";

describe("durable run round continuation", () => {
  it("从当前 run 已持久化的 intent 计算下一逻辑轮次", () => {
    const messages = [
      { metadata: { run_id: "run-1", msg_type: MSG_TYPE.INTENT, round: 1 } },
      { metadata: { run_id: "run-other", msg_type: MSG_TYPE.INTENT, round: 9 } },
      { metadata: { run_id: "run-1", msg_type: MSG_TYPE.OBSERVATION, round: 7 } },
      null,
      { metadata: { run_id: "run-1", msg_type: MSG_TYPE.INTENT, round: 3 } },
    ];

    expect(resolveRunStartRound(messages, "run-1")).toBe(3);
    expect(resolveRunStartRound(messages, "missing")).toBe(0);
  });

  it("只恢复上一逻辑轮次中当前 run 的 durable 工具结果", () => {
    const results = resolveResumeToolResults([{
      tool_call_id: "tool-1",
      metadata: {
        run_id: "run-1",
        msg_type: MSG_TYPE.OBSERVATION,
        round: 2,
        tool_result_ref: {
          success: true,
          tool_name: "read_file",
          summary: "ok",
          answer: null,
          output_type: "json",
          content: { path: "a.txt" },
          metadata: {},
          artifacts: [],
        },
      },
    }], "run-1", 2);

    expect(results.get("tool-1")?.content).toEqual({ path: "a.txt" });
  });

  it("恢复未完成工具调用后从下一轮继续，而不是重新使用 round 0", async () => {
    const executedRounds: number[] = [];
    const invokedRounds: number[] = [];
    const refreshedRounds: number[] = [];
    const calls: KernelToolCall[] = [];
    const restoredResults = new Map<number, unknown>();
    const observations: KernelObservation[] = [];

    const context: Context = { buildMessages: (ctx) => [...ctx.messages] };
    const protocol: Protocol = {
      buildRequest: () => ({ messages: [] } as unknown as ReturnType<Protocol["buildRequest"]>),
      invoke: async (_ctx, round) => {
        invokedRounds.push(round);
        return {
          kind: "final",
          finalAnswer: "done",
          assistantMessage: { role: "assistant", content: "done" },
          finishReason: "stop",
          usage: undefined,
        };
      },
      renderObservations: (roundCalls) => roundCalls.map((call) => ({
        role: "tool" as const,
        content: "ok",
        tool_call_id: call.callId,
      })),
      toModelMessages: (messages) => messages,
    };
    const tools: ToolProvider = {
      executeRound: async (_ctx, round, roundCalls, previousResults = new Map()) => {
        executedRounds.push(round);
        calls.push(...roundCalls);
        for (const [index, result] of previousResults) restoredResults.set(index, result.content);
        return observations;
      },
    };
    const events: EventSink = { emit: () => undefined };
    const kernel = new AgentKernel({
      context,
      protocol,
      tools,
      events,
      refresher: {
        refresh: async (_ctx, round) => {
          refreshedRounds.push(round);
          return [];
        },
      },
      hooks: createHookRegistry(),
    });
    const session = {
      profile: { agentName: "agent" },
      provider: { key: null, provider_type: "test" },
      modelName: "model",
      conversation: [{
        role: "assistant",
        content: "old intent",
        tool_calls: [{
          id: "tool-1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }, {
          id: "tool-2",
          type: "function",
          function: { name: "write_file", arguments: "{\"content\":\"{result_1}\"}" },
        }],
      }, {
        role: "tool",
        content: "first result",
        tool_call_id: "tool-1",
      }],
      sessionId: "session-1",
      runId: "run-1",
      taskId: "task",
      requestId: "request-1",
      rootCallId: "root-call",
      threadKey: "root",
      parentCallId: null,
      startRound: 1,
      resumeToolResults: new Map([[
        "tool-1",
        {
          success: true,
          toolName: "read_file",
          summary: "read",
          answer: null,
          outputType: "text",
          content: "durable content",
          metadata: {},
          artifacts: [],
          llmHint: null,
        },
      ]]),
    } as unknown as RuntimeSession;

    await kernel.run(session);

    expect(executedRounds).toEqual([0]);
    expect(invokedRounds).toEqual([1]);
    expect(refreshedRounds).toEqual([1]);
    expect(calls.map((call) => ({ id: call.callId, index: call.index }))).toEqual([{ id: "tool-2", index: 1 }]);
    expect(restoredResults).toEqual(new Map([[1, "durable content"]]));
  });
});
