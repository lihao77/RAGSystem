import { describe, expect, it } from "vitest";

import { AgentRunEngine } from "../src/services/agent/execution/run-engine.js";

describe("synchronous execution result", () => {
  it("returns canonical final content parts alongside the plain-text answer", async () => {
    const finalParts = [
      { type: "text" as const, text: "洪水分析完成" },
      {
        type: "file_ref" as const,
        file_path: "reports/flood_overview_map_zoomed.png",
        presentation: "inline" as const,
        caption: "优化后的洪水要素分布图",
      },
    ];
    const engine = new AgentRunEngine(
      "tenant-1" as never,
      {} as never,
      {
        resultReader: {
          getRun: async () => ({
            status: "completed",
            final_message_id: "message-final",
            agent_name: "default",
            thread_key: "root",
            child_agent_id: null,
          }),
          getMessageById: async () => ({
            content: "洪水分析完成",
            content_parts: finalParts,
            metadata: { execution_time: 1.25 },
          }),
          listRunSteps: async () => [],
        },
      } as never,
      "",
      null,
      null,
      () => [],
      null,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      null,
      null,
      null,
      null,
    );

    const result = await engine.buildSynchronousResult({
      sessionId: "session-1",
      runId: "run-1",
      taskId: "task-1",
      agentName: "default",
    });

    expect(result.answer).toBe("洪水分析完成");
    expect(result.content_parts).toEqual(finalParts);
  });

  it("preserves canonical parts when a queued follow-up result is joined", async () => {
    const followupParts = [{
      type: "file_ref" as const,
      file_path: "reports/followup.png",
      presentation: "preview" as const,
    }];
    const engine = new AgentRunEngine(
      "tenant-1" as never,
      {} as never,
      { resultReader: { getRun: async () => ({ status: "completed" }) } } as never,
      "",
      null,
      null,
      () => [],
      null,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      null,
    );

    const result = await engine.buildSynchronousResult({
      sessionId: "session-1",
      runId: "run-1",
      taskId: "task-1",
      agentName: "default",
      outcome: {
        content: "follow-up complete",
        success: true,
        followupJoined: true,
        contentParts: followupParts,
      },
    });

    expect(result.answer).toBe("follow-up complete");
    expect(result.content_parts).toEqual(followupParts);
  });

  it("waits for the queued follow-up consumer when the previous run finishes first", async () => {
    let followupReads = 0;
    const engine = new AgentRunEngine(
      "tenant-1" as never,
      {} as never,
      {
        agentMailbox: {
          get: async () => ({ status: "queued" }),
        },
        resultReader: {
          getRun: async (_sessionId: string, runId: string) => ({
            status: "completed",
            final_message_id: runId === "consumer-run" ? "consumer-final" : "previous-final",
          }),
          getMessageById: async (_sessionId: string, messageId: string) => {
            if (messageId === "followup-message") {
              followupReads += 1;
              return {
                metadata: followupReads > 1 ? { consumed_by_run_id: "consumer-run" } : {},
              };
            }
            return {
              content: messageId === "consumer-final" ? "follow-up complete" : "previous run complete",
              content_parts: [{ type: "text" as const, text: messageId }],
              metadata: {},
            };
          },
        },
      } as never,
      "",
      null,
      null,
      () => [],
      null,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      null,
    );

    const result = await (engine as unknown as {
      waitForFollowupCompletion(
        sessionId: string,
        messageId: string,
        initiallyActiveRunId: string,
      ): Promise<{ content: string; success: boolean; runId?: string }>;
    }).waitForFollowupCompletion("session-1", "followup-message", "previous-run");

    expect(followupReads).toBeGreaterThan(1);
    expect(result).toMatchObject({
      content: "follow-up complete",
      success: true,
      runId: "consumer-run",
    });
  });
});
