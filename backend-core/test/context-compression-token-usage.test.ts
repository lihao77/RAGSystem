import { describe, expect, it } from "vitest";
import { estimateRequestTokenUsage, estimateMessageTokens } from "@ragsystem/agent-sdk";
import type { ChatMessage } from "@ragsystem/agent-llm";

import { resolveEffectiveHistoryTokens } from "../src/services/agent/context-compression/compression-service.js";
import {
  readPersistedSessionContextTokenUsage,
  RuntimeInputTokenTracker,
} from "../src/services/agent/context-compression/input-token-tracker.js";

describe("context compression token usage", () => {
  it("prefers provider-adjusted input over the fallback history estimate", () => {
    expect(resolveEffectiveHistoryTokens(100, 30)).toBe(100);
    expect(resolveEffectiveHistoryTokens(100, 30, 180)).toBe(150);
    expect(resolveEffectiveHistoryTokens(100, 30, 20)).toBe(0);
    expect(resolveEffectiveHistoryTokens(100, 30, Number.NaN)).toBe(100);
  });

  it("projects provider input usage over messages added since the observed round", () => {
    const tracker = new RuntimeInputTokenTracker();
    const base: ChatMessage[] = [{ role: "user", content: "a".repeat(40) }];
    tracker.observe({ inputTokens: 150, outputTokens: 10, totalTokens: 160 }, {
      systemPromptTokens: 20,
      historyTokens: 80,
      totalTokens: 100,
      budgetTokens: 1000,
      compressing: false,
    }, base);

    // Provider input + output is the post-round context baseline. The caller anchors
    // working messages after appending the assistant response.
    expect(tracker.predict(base)).toEqual({ inputTokens: 160, systemPromptTokens: 20 });

    const added: ChatMessage = { role: "tool", content: "b".repeat(40), tool_call_id: "call-1" };
    const addedTokens = estimateMessageTokens(added);
    expect(tracker.predict([...base, added])).toEqual({
      inputTokens: 160 + Math.ceil(addedTokens * 1.5),
      systemPromptTokens: 20,
    });
  });

  it("ignores unusable provider input usage", () => {
    const tracker = new RuntimeInputTokenTracker();
    tracker.observe(
      { inputTokens: 0, outputTokens: 5, totalTokens: 5 },
      undefined,
      [{ role: "user", content: "hello" }],
    );
    expect(tracker.predict([{ role: "user", content: "hello again" }])).toBeNull();
  });

  it("restores the last observation only for the same thread and model identity", () => {
    const identity = {
      threadKey: "root",
      agentName: "agent",
      providerKey: "provider",
      modelName: "model",
    };
    const original = new RuntimeInputTokenTracker();
    original.observe({ inputTokens: 150, outputTokens: 5, totalTokens: 155 }, {
      systemPromptTokens: 20,
      historyTokens: 80,
      totalTokens: 100,
      budgetTokens: 1000,
      compressing: false,
    }, [{ role: "user", content: "hello" }]);
    const patch = original.metadataPatch(identity);
    expect(patch).not.toBeNull();

    const restored = new RuntimeInputTokenTracker();
    expect(restored.restore(patch ?? {}, identity)).toBe(true);
    expect(restored.predict([{ role: "user", content: "hello" }])).toEqual({
      inputTokens: 155,
      systemPromptTokens: 20,
    });
    expect(readPersistedSessionContextTokenUsage(patch ?? {}, "root")).toMatchObject({
      contextTokens: 155,
      providerInputTokens: 150,
      providerOutputTokens: 5,
      systemPromptTokens: 20,
    });

    const mismatched = new RuntimeInputTokenTracker();
    expect(mismatched.restore(patch ?? {}, { ...identity, modelName: "other" })).toBe(false);
  });

  it("includes native tool schemas in the final request estimate", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ];
    const withoutTools = estimateRequestTokenUsage({ messages });
    const withTools = estimateRequestTokenUsage({
      messages,
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      }],
    });

    expect(withTools.systemPromptTokens).toBeGreaterThan(withoutTools.systemPromptTokens);
    expect(withTools.totalTokens).toBe(withTools.systemPromptTokens + withTools.historyTokens);
  });
});
