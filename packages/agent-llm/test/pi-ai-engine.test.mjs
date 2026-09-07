import assert from "node:assert/strict";
import test from "node:test";

import { LlmProviderClient } from "../dist/index.js";
import { PiAiAdapter, piUsageToTokenUsage } from "../dist/providers/pi-ai.js";

/** SSE 事件序列 → Response body（anthropic wire 形态，与 pi-ai 手写解码器对齐）。 */
const sseBody = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");

const plainSchemaTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询天气",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

/** thinking + text + tool_use 全块序列，message_start 带 cache 字段。 */
const fullSse = sseBody([
  { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 100, output_tokens: 0 } } } },
  { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
  { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ponder " } } },
  { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } } },
  { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { type: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
  { type: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
  { type: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
  { type: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: "" } } },
  { type: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"北京"}' } } },
  { type: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
  { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } } },
  { type: "message_stop", data: { type: "message_stop" } },
]);

const textOnlySse = sseBody([
  { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
  { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
  { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
  { type: "message_stop", data: { type: "message_stop" } },
]);

const effortProvider = {
  key: "pi",
  name: "pi",
  provider_type: "anthropic",
  api_endpoint: "https://pi.test",
  api_key: "k",
  llm_engine: "pi-ai",
  thinking_kind: "effort",
  thinking_levels: ["low", "high", "max"],
};

function withFetchStub(body, fn) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (input, init) => {
    try {
      let raw = init?.body ?? null;
      if (raw == null && typeof Request !== "undefined" && input instanceof Request) {
        raw = await input.clone().text();
      }
      captured = typeof raw === "string" && raw ? JSON.parse(raw) : null;
    } catch { captured = null; }
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return Promise.resolve(fn(() => captured)).finally(() => {
    globalThis.fetch = original;
  });
}

test("pi-ai 引擎 effort 形状：wire 落 output_config.effort + 纯 JSON Schema 工具 + 全链翻译", async () => {
  await withFetchStub(fullSse, async (getCaptured) => {
    const adapter = new PiAiAdapter();
    const chunks = [];
    const result = await adapter.stream(
      {
        provider: effortProvider,
        model: "glm-test",
        messages: [{ role: "user", content: "hi" }],
        thinkingLevel: "max",
        tools: [plainSchemaTool],
        toolChoice: "auto",
        maxCompletionTokens: 2048,
      },
      async (chunk) => { chunks.push(chunk); },
    );
    const body = getCaptured();
    // effort 型兼容端点通道（forceAdaptiveThinking）：智谱/Kimi 等 /v1/messages 网关唯一生效档位字段
    assert.equal(body.output_config?.effort, "max");
    assert.equal(body.thinking?.type, "adaptive");
    // 纯 JSON Schema 工具定义原样落线（pi Tool.parameters 无需 TypeBox 构造）
    assert.deepEqual(body.tools?.[0]?.input_schema, plainSchemaTool.function.parameters);
    assert.equal(body.max_tokens, 2048);

    // chunks：thinking 增量转 reasoning、text 转正文、toolcall 终块转工具调用
    assert.deepEqual(
      chunks.filter((c) => c.content || c.reasoning).map((c) => (c.reasoning ? { content: "", reasoning: c.reasoning } : { content: c.content })),
      [{ content: "", reasoning: "ponder " }, { content: "answer" }],
    );
    const toolChunks = chunks.flatMap((c) => c.toolCalls ?? []);
    assert.equal(toolChunks.length, 1);
    assert.deepEqual(toolChunks[0].function, { name: "get_weather", arguments: '{"city":"北京"}' });

    // 终态：inclusive usage / 推理块带签名 / 工具调用 / finishReason 归一
    assert.deepEqual(result.usage, {
      inputTokens: 150, outputTokens: 9, totalTokens: 159, cachedInputTokens: 100, cacheCreationInputTokens: 30,
    });
    assert.deepEqual(result.reasoningBlocks, [{ type: "thinking", thinking: "ponder ", signature: "sig-1" }]);
    assert.equal(result.reasoning, "ponder ");
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls?.[0]?.function, { name: "get_weather", arguments: '{"city":"北京"}' });
  });
});

test("pi-ai 引擎经 LlmProviderClient 路由（llm_engine 声明命中，缺省仍走原生）", async () => {
  await withFetchStub(textOnlySse, async () => {
    const client = new LlmProviderClient();
    const result = await client.complete({
      provider: effortProvider,
      model: "glm-test",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.content, "ok");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.usage.inputTokens, 12);
  });
});

test("pi-ai 引擎 budget 形状：thinkingBudgets 预算阶梯落线", async () => {
  await withFetchStub(textOnlySse, async (getCaptured) => {
    const adapter = new PiAiAdapter();
    await adapter.complete({
      // max_completion_tokens 给足：pi 会把预算钳到 maxTokens-1024（思考不挤占答案空间）
      provider: { ...effortProvider, thinking_kind: "budget", thinking_levels: ["low", "medium", "high"], max_completion_tokens: 131072 },
      model: "glm-test",
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "high",
    });
    const body = getCaptured();
    assert.equal(body.thinking?.type, "enabled");
    assert.equal(body.thinking?.budget_tokens, 32768);
    assert.equal(body.output_config, undefined);
  });
});

test("pi-ai 引擎形状/档位校验：toggle 无子集拒绝、越界档位拒绝", async () => {
  const adapter = new PiAiAdapter();
  // openai 格式下 toggle 无子集保持开关形状（anthropic 会折叠 budget），pi 引擎显式拒绝
  await assert.rejects(
    () => adapter.complete({
      provider: { ...effortProvider, provider_type: "openai_chat", thinking_kind: "toggle", thinking_levels: undefined },
      model: "glm-test",
      messages: [{ role: "user", content: "hi" }],
    }),
    /pi-ai 引擎暂不支持 toggle/,
  );
  await assert.rejects(
    () => adapter.complete({
      provider: effortProvider,
      model: "glm-test",
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "medium",
    }),
    /not supported by pi-ai engine/,
  );
});

test("pi usage（disjoint）→ TokenUsage（inclusive）纯映射", () => {
  assert.deepEqual(
    piUsageToTokenUsage({ input: 20, output: 9, cacheRead: 100, cacheWrite: 30, totalTokens: 159 }),
    { inputTokens: 150, outputTokens: 9, totalTokens: 159, cachedInputTokens: 100, cacheCreationInputTokens: 30 },
  );
  assert.deepEqual(
    piUsageToTokenUsage({ input: 12, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 14 }),
    { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
  );
  assert.deepEqual(piUsageToTokenUsage(undefined), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});
