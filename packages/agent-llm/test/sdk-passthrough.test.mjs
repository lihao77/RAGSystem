import assert from "node:assert/strict";
import test from "node:test";

import { GeminiAdapter } from "../dist/index.js";
import { OpenAiChatAdapter } from "../dist/providers/openai-chat.js";
import { extractOpenAiUsage } from "../dist/internal/usage.js";

test("Gemini 经 @google/genai 透传未知厂商字段（extraBody 深合并兜底）", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = null;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new GeminiAdapter().complete({
      provider: {
        key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "secret",
        api_endpoint: "https://generativelanguage.googleapis.com/v1beta",
      },
      model: "gemini-2.5-flash",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      // generationConfig 内的未知键 + 顶层未知键都必须原样到达请求体
      extraParams: { generationConfig: { responseThinkingConfig: { enabled: true } }, vendorExtension: { flag: 1 } },
      temperature: 0.3,
    });
    assert.equal(result.content, "ok");
    assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(capturedBody.systemInstruction.parts[0].text, "sys");
    assert.equal(capturedBody.generationConfig.temperature, 0.3);
    assert.deepEqual(capturedBody.generationConfig.responseThinkingConfig, { enabled: true });
    assert.deepEqual(capturedBody.vendorExtension, { flag: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini provider 配置 ipc_socket 传输时显式拒绝", async () => {
  await assert.rejects(
    new GeminiAdapter().complete({
      provider: {
        key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "secret",
        transport: { type: "ipc_socket", socket_env: "NOPE" },
      },
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
    /does not support the ipc_socket transport/,
  );
});

test("openai_chat usage 回退到 choice.usage（Moonshot 系网关）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
    }],
  }), { headers: { "content-type": "application/json" } });
  try {
    const result = await new OpenAiChatAdapter().complete({
      provider: { key: "moonshot", name: "moonshot", provider_type: "openai_chat", api_key: "secret", api_endpoint: "https://x/v1" },
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedInputTokens: 5 });
    // 顶层 usage 优先，choice.usage 仅作回退
    assert.equal(extractOpenAiUsage({ usage: { prompt_tokens: 1, completion_tokens: 1 } }).inputTokens, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini 模型名带 models/ 前缀时 URL 不重复拼接", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    await new GeminiAdapter().complete({
      provider: {
        key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "secret",
        api_endpoint: "https://generativelanguage.googleapis.com/v1beta",
      },
      model: "models/gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
