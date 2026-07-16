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

/** 取 message 末 content block 的 cache_control（messages 段断点打在 block 上,不在 message 顶层）。 */
function lastBlockCacheControl(msg: unknown): { type: string } | undefined {
  const content = (msg as { content?: unknown[] }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  return (content[content.length - 1] as CacheMarked).cache_control;
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

  it("history: 倒数二(上轮 assistant)末 block 带 cache_control,其余 history 与末尾不带", () => {
    const body = buildAnthropicBody(makeRequest({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(3); // system 被滤掉
    expect(lastBlockCacheControl(msgs[1])).toEqual({ type: "ephemeral" }); // 倒数二 a1
    expect(lastBlockCacheControl(msgs[0])).toBeUndefined(); // u1
    expect(lastBlockCacheControl(msgs[2])).toBeUndefined(); // 末尾 u2(本轮新输入)
  });

  it("history 工具调用: 倒数二 assistant 末 tool_use block 带,末尾 tool_result 不带", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(3); // user(u1) + assistant(tool_use) + user(tool_result)
    expect(lastBlockCacheControl(msgs[1])).toEqual({ type: "ephemeral" }); // 倒数二 assistant 末 tool_use
    expect(lastBlockCacheControl(msgs[0])).toBeUndefined(); // u1
    expect(lastBlockCacheControl(msgs[2])).toBeUndefined(); // 末尾 tool_result
  });

  it("history 仅 1 条 user(第一轮): 不打第 3 断点,system/tools 仍打", () => {
    const body = buildAnthropicBody(makeRequest({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u1" }],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(1);
    expect(lastBlockCacheControl(msgs[0])).toBeUndefined();
    expect(lastCacheControl(body.system)).toEqual({ type: "ephemeral" });
    expect(lastCacheControl(body.tools)).toEqual({ type: "ephemeral" });
  });

  it("history 末尾连续 user(additionalContext) coalesce 合并: 仍只打倒数二 assistant,合并 user 全不带", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "user", content: "<additional_context>ctx</additional_context>" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(3); // coalesce: [u1, a1, user(u2+ctx 合并)]
    expect(lastBlockCacheControl(msgs[1])).toEqual({ type: "ephemeral" }); // 倒数二 a1
    const mergedContent = (msgs[2] as { content: unknown[] }).content;
    expect(mergedContent.length).toBe(2); // u2 text + ctx text
    for (const block of mergedContent) {
      expect((block as CacheMarked).cache_control).toBeUndefined();
    }
  });

  it("supports_prompt_caching === false → 最后一条 assistant 也不带 cache_control", () => {
    const body = buildAnthropicBody(makeRequest({
      provider: { supports_prompt_caching: false },
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(lastBlockCacheControl(msgs[1])).toBeUndefined();
  });

  it("history 末尾 assistant(compact 摘要/异常形态): 断点打最后一条 assistant,不误打倒数二 user", () => {
    // compact 摘要落成 assistant 放视图首位(history-view.ts),若 conversation 末尾为 assistant,
    // 倒数二不再是 assistant。按 role 定位(最后一条 assistant)而非位置(length-2)才能打对。
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "assistant", content: "[summary]" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(3);
    expect(lastBlockCacheControl(msgs[2])).toEqual({ type: "ephemeral" }); // 最后一条 assistant = 末尾 a1
    expect(lastBlockCacheControl(msgs[1])).toBeUndefined(); // 倒数二 user 不打
    expect(lastBlockCacheControl(msgs[0])).toBeUndefined(); // 非末位 summary assistant 不打
  });

  it("history 最后一条 assistant 纯文本空 content → 跳过空 block 不打(空 text block 打标会被 Anthropic 400)", () => {
    // 模型空响应/异常中间态产 content:"" 的纯文本 assistant,toAnthropicContent 给 [{text:""}];
    // 在空 text block 上打 cache_control 会被 Anthropic 拒绝(400)。须跳过;此例前面无非空 assistant,回溯也找不到,不打。
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "" },
        { role: "user", content: "u2" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(3); // [u1, assistant(空 text), u2]
    expect(lastBlockCacheControl(msgs[1])).toBeUndefined(); // 空 text block 不打
    expect(lastBlockCacheControl(msgs[0])).toBeUndefined();
    expect(lastBlockCacheControl(msgs[2])).toBeUndefined();
  });

  it("history 最后一条 assistant 空 content、前面有非空 assistant → 回溯打前一条非空 assistant", () => {
    // 空 assistant 无实质内容、不算"上一轮结尾",回溯更早的实质 assistant 保住稳定历史 cache。
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "" },
        { role: "user", content: "u3" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(5);
    expect(lastBlockCacheControl(msgs[1])).toEqual({ type: "ephemeral" }); // 回溯打 a1
    expect(lastBlockCacheControl(msgs[3])).toBeUndefined(); // 空 assistant 不打
    expect(lastBlockCacheControl(msgs[0])).toBeUndefined();
    expect(lastBlockCacheControl(msgs[2])).toBeUndefined();
    expect(lastBlockCacheControl(msgs[4])).toBeUndefined();
  });

  it("history assistant 同时有非空 text + tool_use → 断点打末尾 tool_use", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "intent text", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
    }));
    const msgs = body.messages as unknown[];
    expect(msgs.length).toBe(3); // [u1, assistant(text+tool_use), user(tool_result)]
    const assistantBlocks = (msgs[1] as { content: unknown[] }).content;
    expect(assistantBlocks.length).toBe(2); // text + tool_use
    expect((assistantBlocks[1] as CacheMarked).cache_control).toEqual({ type: "ephemeral" }); // 末 tool_use 打
    expect((assistantBlocks[0] as CacheMarked).cache_control).toBeUndefined(); // text 不打
    expect(lastBlockCacheControl(msgs[2])).toBeUndefined(); // 末尾 tool_result 不打
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
  it("coalesces a post-tool image message into Anthropic user content without losing the image block", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t1", name: "screenshot", content: "截图完成" },
        { role: "user", content: [
          { type: "text", text: "Images returned by tool screenshot (call_id=t1)" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ] },
      ],
    }));

    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_result", tool_use_id: "t1" }),
      expect.objectContaining({ type: "image" }),
    ]));
  });

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

describe("buildAnthropicBody — provider continuation", () => {
  it("only replays the newest thinking state across repeated tool rounds", () => {
    const body = buildAnthropicBody(makeRequest({
      tools: [],
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "",
          provider_continuation: {
            protocol: "anthropic_messages",
            toolCallIds: ["t1"],
            blocks: [{ type: "thinking", thinking: "old", signature: "sig-old" }],
          },
          tool_calls: [{ id: "t1", type: "function", function: { name: "one", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "one result" },
        {
          role: "assistant",
          content: "",
          provider_continuation: {
            protocol: "anthropic_messages",
            toolCallIds: ["t2"],
            blocks: [{ type: "thinking", thinking: "new", signature: "sig-new" }],
          },
          tool_calls: [{ id: "t2", type: "function", function: { name: "two", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t2", content: "two result" },
      ],
    }));
    const blocks = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)
      .flatMap((message) => message.content)
      .filter((block) => block.type === "thinking");
    expect(blocks).toEqual([{ type: "thinking", thinking: "new", signature: "sig-new" }]);
  });
});
