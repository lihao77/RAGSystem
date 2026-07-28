import { describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "@ragsystem/agent-llm";
import { RecoverableInterrupt } from "@ragsystem/agent-sdk";
import {
  buildTool,
  createHookRegistry,
  createToolRegistry,
  executeToolCallRound,
  type AgentProfile,
  type ToolExecutionResult,
} from "@ragsystem/agent-sdk";

const provider: ProviderConfig = { key: "test", name: "test", provider_type: "openai" };
const profile: AgentProfile = {
  agentName: "orchestrator_agent",
  behavior: { systemPrompt: "", compressionTriggerRatio: null, summarizeMaxTokens: null, preserveRecentTurns: null },
  llmTiers: {
    default: {
      provider,
      modelName: "test-model",
      temperature: null,
      maxCompletionTokens: null,
      maxContextTokens: 128000,
      extraParams: {},
    },
  },
};

describe("tool approval batch preflight", () => {
  it("registers every gate in the dependency-ready batch before suspending", async () => {
    const calls = [
      { index: 0, callId: "call-write-1", toolName: "write_one", arguments: {} },
      { index: 1, callId: "call-write-2", toolName: "write_two", arguments: {} },
    ];
    const executed = vi.fn(() => successResult());
    const registry = createToolRegistry({
      tools: calls.map((call) => buildTool({
        name: call.toolName,
        description: call.toolName,
        checkAccess: () => ({ action: "ask", reason: "approval required" }),
        call: executed,
      })),
    });
    const hooks = createHookRegistry();
    const gated: Array<{ callId: string | null; batchId: string | undefined }> = [];
    hooks.on("tool.gate", async ({ ctx }) => {
      gated.push({ callId: ctx.toolCallId, batchId: ctx.interactionBatchId });
      throw new RecoverableInterrupt({
        sessionId: "session-1",
        runId: "run-1",
        rootRunId: "run-1",
        parentRunId: null,
        parentCallId: null,
        toolCallId: ctx.toolCallId ?? "",
        kind: "approval",
      });
    });

    await expect(executeToolCallRound(calls, {
      registry,
      hooks,
      toolContext: {
        sessionId: "session-1",
        runId: "run-1",
        rootRunId: "run-1",
        taskId: "task-1",
        requestId: "request-1",
        parentCallId: "root-call",
        toolCallId: null,
        round: null,
        order: null,
        roundIndex: null,
      },
      dataRoot: process.cwd(),
      round: 0,
      agentName: "orchestrator_agent",
      profile,
      provider,
      events: { emit() {} },
    })).rejects.toBeInstanceOf(RecoverableInterrupt);

    expect(gated).toHaveLength(2);
    expect(gated.map((item) => item.callId)).toEqual(["call-write-1", "call-write-2"]);
    expect(new Set(gated.map((item) => item.batchId)).size).toBe(1);
    expect(executed).not.toHaveBeenCalled();
  });
});

function successResult(): ToolExecutionResult {
  return {
    success: true,
    toolName: "write",
    summary: "done",
    answer: null,
    outputType: "text",
    content: "done",
    metadata: {},
    artifacts: [],
    llmHint: null,
  };
}
