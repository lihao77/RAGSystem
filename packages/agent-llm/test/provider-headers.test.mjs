import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_ID_PLACEHOLDER, isValidHeaderName, isValidHeaderValue, resolveProviderHeaders } from "../dist/provider-headers.js";
import { GeminiAdapter } from "../dist/index.js";
import { OpenAiChatAdapter } from "../dist/providers/openai-chat.js";
import { OpenAiResponsesAdapter } from "../dist/providers/openai-responses.js";
import { AnthropicAdapter } from "../dist/providers/anthropic.js";
import { PiAiAdapter } from "../dist/providers/pi-ai.js";

// ───────────────────────────── 解析器单测 ─────────────────────────────

const makeProvider = (headers) => ({
  key: "opencode-go",
  name: "OpenCode Go",
  provider_type: "openai_chat",
  api_key: "k",
  headers,
});

test("未配置/空 headers → undefined（零开销短路）", () => {
  assert.equal(resolveProviderHeaders(makeProvider(undefined), "s1"), undefined);
  assert.equal(resolveProviderHeaders(makeProvider(null), "s1"), undefined);
  assert.equal(resolveProviderHeaders(makeProvider({}), "s1"), undefined);
  assert.equal(resolveProviderHeaders(makeProvider([["a", "b"]]), "s1"), undefined);
});

test("静态头原样透传", () => {
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ "X-Gateway-Tag": "ragsystem" }), "s1"),
    { "X-Gateway-Tag": "ragsystem" },
  );
});

test("{session_id} 占位符解析为 promptCacheKey（网关会话路由/缓存亲和）", () => {
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ "x-opencode-session": "{session_id}", session_id: "{session_id}" }), "ragsystem:abc"),
    { "x-opencode-session": "ragsystem:abc", session_id: "ragsystem:abc" },
  );
});

test("占位符与静态文本混合、多次出现全部替换", () => {
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ session_id: `pre-${SESSION_ID_PLACEHOLDER}-mid-${SESSION_ID_PLACEHOLDER}` }), "s9"),
    { session_id: "pre-s9-mid-s9" },
  );
});

test("无 promptCacheKey 的辅助调用回落 provider 级稳定值（硬性网关不 400）", () => {
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ "x-opencode-session": "{session_id}" }), undefined),
    { "x-opencode-session": "ragsystem:aux:opencode-go" },
  );
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ "x-opencode-session": "{session_id}" }), "  "),
    { "x-opencode-session": "ragsystem:aux:opencode-go" },
  );
});

test("键 trim、空白键与非字符串值丢弃（传输层防御性二道闸）", () => {
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ "  x-a  ": "1", "": "2", "x-b": 3, "x-c": null }), "s"),
    { "x-a": "1" },
  );
});

test("非法 header 名/值在解析层丢弃（防 undici 请求构造期抛错）", () => {
  assert.deepEqual(
    resolveProviderHeaders(makeProvider({ "x-session id": "v", "x-crlf": "a\r\nb", "x-nul": "a\0b", "x-ok": "fine" }), "s"),
    { "x-ok": "fine" },
  );
  // 值中文名（非 latin1）同样拦截；占位符解析产物（哈希）天然安全不受影响
  assert.equal(resolveProviderHeaders(makeProvider({ "x-zh": "标签" }), "s"), undefined);
});

test("校验器：RFC 7230 token 名 / 可打印 latin1 值", () => {
  assert.equal(isValidHeaderName("x-opencode-session"), true);
  assert.equal(isValidHeaderName("session_id"), true);
  assert.equal(isValidHeaderName("X-Request-Id_01"), true);
  assert.equal(isValidHeaderName(""), false);
  assert.equal(isValidHeaderName("x bad"), false);
  assert.equal(isValidHeaderName("a\r\nb"), false);
  assert.equal(isValidHeaderName("名"), false);
  assert.equal(isValidHeaderValue("tag {session_id} 123"), true);
  assert.equal(isValidHeaderValue("tab\tinside"), true);
  assert.equal(isValidHeaderValue("é"), true); // latin1 扩展合法
  assert.equal(isValidHeaderValue("a\r\nb"), false);
  assert.equal(isValidHeaderValue("a\0b"), false);
  assert.equal(isValidHeaderValue("中文"), false);
});

test("aux 回落：provider 标识非头值安全字符（中文 name）时折叠为稳定哈希", () => {
  const headers = resolveProviderHeaders(
    { key: null, name: "中文网关", provider_type: "openai_chat", api_key: "k", headers: { "x-opencode-session": "{session_id}" } },
    undefined,
  );
  assert.match(headers["x-opencode-session"], /^ragsystem:aux:[0-9a-f]{16}$/);
  // 同一 provider 两次解析同值（稳定）、不同 provider 不同值（可区分）
  const again = resolveProviderHeaders(
    { key: null, name: "中文网关", provider_type: "openai_chat", api_key: "k", headers: { "x-opencode-session": "{session_id}" } },
    undefined,
  );
  assert.equal(headers["x-opencode-session"], again["x-opencode-session"]);
});

// ───────────────────── 适配器注入（stub fetch 断言请求头） ─────────────────────

/** 捕获请求头并按 dialect 返回最小合法响应。 */
function withHeaderCapture(responseFactory, fn) {
  const original = globalThis.fetch;
  const capturedHeaders = [];
  globalThis.fetch = async (_input, init) => {
    capturedHeaders.push(new Headers(init?.headers ?? {}));
    return responseFactory();
  };
  return Promise.resolve(fn(capturedHeaders)).finally(() => {
    globalThis.fetch = original;
  });
}

test("openai_chat：自定义头经 defaultHeaders 到达 wire（占位符解析）", async () => {
  await withHeaderCapture(
    () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }),
    async (captured) => {
      const result = await new OpenAiChatAdapter().complete({
        provider: makeProvider({ "x-opencode-session": "{session_id}", "X-Gateway-Tag": "ragsystem" }),
        model: "glm-5.3",
        messages: [{ role: "user", content: "hi" }],
        promptCacheKey: "ragsystem:thread-1",
      });
      assert.equal(result.content, "ok");
      assert.equal(captured[0].get("x-opencode-session"), "ragsystem:thread-1");
      assert.equal(captured[0].get("X-Gateway-Tag"), "ragsystem");
    },
  );
});

test("openai_chat：无 promptCacheKey 的辅助调用带回落头（不发裸占位符）", async () => {
  await withHeaderCapture(
    () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }),
    async (captured) => {
      await new OpenAiChatAdapter().complete({
        provider: makeProvider({ "x-opencode-session": "{session_id}" }),
        model: "glm-5.3",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(captured[0].get("x-opencode-session"), "ragsystem:aux:opencode-go");
      assert.ok(!captured[0].get("x-opencode-session").includes(SESSION_ID_PLACEHOLDER));
    },
  );
});

test("openai_chat：未配置 headers 时不注入（Authorization 照常）", async () => {
  await withHeaderCapture(
    () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }),
    async (captured) => {
      await new OpenAiChatAdapter().complete({
        provider: makeProvider(undefined),
        model: "glm-5.3",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(captured[0].get("x-opencode-session"), null);
      assert.equal(captured[0].get("authorization"), "Bearer k");
    },
  );
});

test("anthropic：自定义头经 defaultHeaders 到达 wire", async () => {
  await withHeaderCapture(
    () => new Response(JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { "content-type": "application/json" } }),
    async (captured) => {
      const result = await new AnthropicAdapter().complete({
        provider: {
          key: "anthropic-gw", name: "Anthropic GW", provider_type: "anthropic", api_key: "k",
          api_endpoint: "https://gw.test/anthropic",
          headers: { "x-opencode-session": "{session_id}" },
        },
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        promptCacheKey: "ragsystem:thread-2",
      });
      assert.equal(result.content, "ok");
      assert.equal(captured[0].get("x-opencode-session"), "ragsystem:thread-2");
    },
  );
});

test("openai_resp：自定义头经 defaultHeaders 到达 wire", async () => {
  await withHeaderCapture(
    () => new Response(JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    }), { headers: { "content-type": "application/json" } }),
    async (captured) => {
      const result = await new OpenAiResponsesAdapter().complete({
        provider: {
          key: "resp-gw", name: "Resp GW", provider_type: "openai_resp", api_key: "k",
          api_endpoint: "https://gw.test/v1",
          headers: { "x-opencode-session": "{session_id}" },
        },
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
        promptCacheKey: "ragsystem:thread-5",
      });
      assert.equal(result.content, "ok");
      assert.equal(captured[0].get("x-opencode-session"), "ragsystem:thread-5");
    },
  );
});

test("gemini：自定义头经客户端级 httpOptions.headers 到达 wire", async () => {
  await withHeaderCapture(
    () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }), { headers: { "content-type": "application/json" } }),
    async (captured) => {
      const result = await new GeminiAdapter().complete({
        provider: {
          key: "gemini-gw", name: "Gemini GW", provider_type: "gemini", api_key: "k",
          api_endpoint: "https://gemini-gw.test/v1beta",
          headers: { "x-session-id": "{session_id}" },
        },
        model: "gemini-test",
        messages: [{ role: "user", content: "hi" }],
        promptCacheKey: "ragsystem:thread-3",
      });
      assert.equal(result.content, "ok");
      assert.equal(captured[0].get("x-session-id"), "ragsystem:thread-3");
    },
  );
});

const piSseBody = [
  { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
  { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
  { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
  { type: "message_stop", data: { type: "message_stop" } },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
  .join("");

test("pi-ai 引擎：自定义头经 ProviderRequestOptions.headers 到达 wire", async () => {
  await withHeaderCapture(
    () => new Response(piSseBody, { headers: { "content-type": "text/event-stream" } }),
    async (captured) => {
      const result = await new PiAiAdapter().complete({
        provider: {
          key: "pi-gw", name: "PI GW", provider_type: "anthropic", api_key: "k",
          api_endpoint: "https://pi.test",
          llm_engine: "pi-ai",
          thinking_kind: "effort",
          thinking_levels: ["low", "high", "max"],
          headers: { "x-opencode-session": "{session_id}" },
        },
        model: "glm-test",
        messages: [{ role: "user", content: "hi" }],
        promptCacheKey: "ragsystem:thread-4",
      });
      assert.equal(result.content, "ok");
      assert.equal(captured[0].get("x-opencode-session"), "ragsystem:thread-4");
    },
  );
});
