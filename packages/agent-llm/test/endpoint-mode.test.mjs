import assert from "node:assert/strict";
import test from "node:test";

import { openAiMethodUrl, anthropicMethodUrl } from "../dist/transport.js";
import { LlmProviderClient } from "../dist/index.js";

/**
 * endpoint_mode 两形态的 URL 拼装契约：
 * - base（缺省）：归一到规范根再拼（裸域名自动补 /v1——Sub2API 类网关根路径是前端
 *   SPA，裸拼方法段拿到 200+HTML 空流的根因形状在此钉住）；
 * - full：完整方法 URL 原样直用（根路径网关逃生通道），无方法段 = 误配显式报错。
 */

function openaiProvider(apiEndpoint, endpointMode) {
  return {
    key: "test", name: "gw", provider_type: "openai_chat", api_key: "secret",
    api_endpoint: apiEndpoint, ...(endpointMode ? { endpoint_mode: endpointMode } : {}),
  };
}

test("base 缺省：裸域名自动补 /v1（本次事故回归夹具）", () => {
  assert.equal(
    openAiMethodUrl(openaiProvider("https://pqy.zeabur.app"), "/chat/completions"),
    "https://pqy.zeabur.app/v1/chat/completions",
  );
  assert.equal(
    openAiMethodUrl(openaiProvider("https://pqy.zeabur.app"), "/responses"),
    "https://pqy.zeabur.app/v1/responses",
  );
});

test("base 缺省：已带 /v1 版本段的基座恒等（存量配置零改写）", () => {
  for (const endpoint of ["https://api.openai.com/v1", "https://api.openai.com/v1/", "https://api.deepseek.com/v1"]) {
    assert.equal(
      openAiMethodUrl(openaiProvider(endpoint), "/chat/completions"),
      `${endpoint.replace(/\/+$/, "")}/chat/completions`,
    );
  }
  assert.equal(
    openAiMethodUrl(openaiProvider("https://dashscope.aliyuncs.com/compatible-mode/v1"), "/chat/completions"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
});

test("base 缺省：误粘完整方法段/尾斜杠一律归一到 /v1 规范布局", () => {
  assert.equal(
    openAiMethodUrl(openaiProvider("https://gw.example/chat/completions"), "/chat/completions"),
    "https://gw.example/v1/chat/completions",
  );
  assert.equal(
    openAiMethodUrl(openaiProvider("https://gw.example/v1/responses"), "/responses"),
    "https://gw.example/v1/responses",
  );
});

test("full：完整方法 URL 原样直用（根路径网关不被强加 /v1）", () => {
  assert.equal(
    openAiMethodUrl(openaiProvider("https://gw.example/chat/completions", "full"), "/chat/completions"),
    "https://gw.example/chat/completions",
  );
  assert.equal(
    openAiMethodUrl(openaiProvider("https://gw.example/v1/responses/", "full"), "/responses"),
    "https://gw.example/v1/responses",
  );
});

test("full：endpoint 不以方法段结尾 = 误配，显式报错而非落回空流陷阱", () => {
  assert.throws(
    () => openAiMethodUrl(openaiProvider("https://gw.example/v1", "full"), "/chat/completions"),
    /endpoint_mode=full.*\/chat\/completions/,
  );
});

test("anthropic base 缺省：归一根 + /v1/messages（既有语义不变）", () => {
  assert.equal(
    anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://pqy.zeabur.app" }),
    "https://pqy.zeabur.app/v1/messages",
  );
  assert.equal(
    anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://api.deepseek.com/anthropic" }),
    "https://api.deepseek.com/anthropic/v1/messages",
  );
  assert.equal(
    anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://api.kimi.com/coding/v1" }),
    "https://api.kimi.com/coding/v1/messages",
  );
});

test("anthropic full：完整方法 URL 原样直用；无 /messages 结尾显式报错", () => {
  assert.equal(
    anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://gw.example/anthropic/v1/messages", endpoint_mode: "full" }),
    "https://gw.example/anthropic/v1/messages",
  );
  assert.throws(
    () => anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://gw.example", endpoint_mode: "full" }),
    /endpoint_mode=full.*\/messages/,
  );
});

test("base 缺省：非 /v1 版本段结尾（智谱 v4 / 方舟 v3 / v1beta）只拼方法段，不强插 /v1", () => {
  for (const endpoint of [
    "https://open.bigmodel.cn/api/paas/v4",
    "https://ark.cn-beijing.volces.com/api/v3",
    "https://gw.example/v1beta",
  ]) {
    assert.equal(
      openAiMethodUrl(openaiProvider(endpoint), "/chat/completions"),
      `${endpoint}/chat/completions`,
    );
  }
});

test("full：跨方法段误配（openai_resp 用 /chat/completions 结尾的完整 URL）显式报错", () => {
  assert.throws(
    () => openAiMethodUrl(openaiProvider("https://gw.example/v1/chat/completions", "full"), "/responses"),
    /endpoint_mode=full.*\/responses/,
  );
});

test("anthropic base：方法/版本段尾巴剥除后重拼（存量形状回归夹具）", () => {
  assert.equal(
    anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://gw.example/v1/messages" }),
    "https://gw.example/v1/messages",
  );
  assert.equal(
    anthropicMethodUrl({ key: "t", name: "a", provider_type: "anthropic", api_endpoint: "https://gw.example/messages" }),
    "https://gw.example/v1/messages",
  );
});

test("端到端：裸域名 openai_chat provider 实际请求 /v1/chat/completions", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const client = new LlmProviderClient();
    await client.complete({
      provider: openaiProvider("https://pqy.zeabur.app"),
      model: "glm-5.3",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.deepEqual(urls, ["https://pqy.zeabur.app/v1/chat/completions"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
