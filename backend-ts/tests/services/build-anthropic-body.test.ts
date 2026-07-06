import { describe, it, expect } from "vitest";
import { buildAnthropicBody } from "@ragsystem/agent-llm";
import type { LlmRequest, ProviderConfig } from "@ragsystem/agent-llm";

type CacheMarked = { cache_control?: { type: string } };

function makeRequest(overrides: {
  provider?: Partial<ProviderConfig>;
  messages?: LlmRequest["messages"];
  tools?: LlmRequest["tools"];
} = {}): LlmRequest {
  return {
    model: "claude-3",
    provider: { key: "p", name: "anthropic", provider_type: "anthropic", ...overrides.provider },
    messages: overrides.messages ?? [
      { role: "system", content: "system prompt" },
      { role: "system", content: "memory block" },
      { role: "user", content: "hi" },
    ],
    tools: overrides.tools ?? [
      { type: "function", function: { name: "tool_a", description: "a", parameters: { type: "object" } } },
      { type: "function", function: { name: "tool_b", description: "b", parameters: { type: "object" } } },
    ],
  };
}

function lastCacheControl(arr: unknown): { type: string } | undefined {
  if (!Array.isArray(arr) || arr.length === 0) {
    return undefined;
  }
  return (arr[arr.length - 1] as CacheMarked).cache_control;
}

describe("buildAnthropicBody — cache_control 打标", () => {
  it("supports_prompt_caching 默认(未设)→ system 末块 + tools 末块各打 cache_control,非末块不打", () => {
    const body = buildAnthropicBody(makeRequest());
    const system = body.system as CacheMarked[];
    const tools = body.tools as CacheMarked[];
    expect(lastCacheControl(system)).toEqual({ type: "ephemeral" });
    expect(system[0]?.cache_control).toBeUndefined();
    expect(lastCacheControl(tools)).toEqual({ type: "ephemeral" });
    expect(tools[0]?.cache_control).toBeUndefined();
  });

  it("supports_prompt_caching === true → system/tools 末块各打", () => {
    const body = buildAnthropicBody(makeRequest({ provider: { supports_prompt_caching: true } }));
    expect(lastCacheControl(body.system)).toEqual({ type: "ephemeral" });
    expect(lastCacheControl(body.tools)).toEqual({ type: "ephemeral" });
  });

  it("supports_prompt_caching === false → system/tools 都不打 cache_control", () => {
    const body = buildAnthropicBody(makeRequest({ provider: { supports_prompt_caching: false } }));
    expect(lastCacheControl(body.system)).toBeUndefined();
    expect(lastCacheControl(body.tools)).toBeUndefined();
  });

  it("history messages 不带 cache_control", () => {
    const body = buildAnthropicBody(makeRequest());
    for (const msg of body.messages as CacheMarked[]) {
      expect(msg.cache_control).toBeUndefined();
    }
  });

  it("system 空 → system 段不打;tools 段仍打", () => {
    const body = buildAnthropicBody(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(body.system).toBeUndefined();
    expect(lastCacheControl(body.tools)).toEqual({ type: "ephemeral" });
  });

  it("tools 空 → tools 段不打;system 段仍打", () => {
    const body = buildAnthropicBody(makeRequest({ tools: [] }));
    expect(body.tools).toBeUndefined();
    expect(lastCacheControl(body.system)).toEqual({ type: "ephemeral" });
  });
});

describe("buildAnthropicBody — 连续 user 合并", () => {
  it("相邻两条 user → 合并为一条,content 数组含两段 text", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    }));
    const msgs = body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content.map((b) => b.text)).toEqual(["first", "second"]);
  });

  it("user + assistant + user → 不相邻不合并,各保留", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    }));
    const msgs = body.messages as Array<{ role: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("tool_result(user) + user(附加上下文) → 合并进同一条 user(混排 tool_result + text)", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "result" },
        { role: "user", content: "ctx" },
      ],
    }));
    const msgs = body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    // assistant(tool_use) 不合并;末尾 tool→user(tool_result) 与 user(ctx) 合并
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user"]);
    const merged = msgs[1]!.content;
    expect(merged.some((b) => b.type === "tool_result")).toBe(true);
    expect(merged.some((b) => b.type === "text")).toBe(true);
  });
});
