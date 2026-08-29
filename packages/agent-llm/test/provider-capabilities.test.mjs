import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_TYPE_SET,
  parseProviderContinuationState,
  providerTypeSpec,
  providerUsesNativeFunctionCalling,
} from "../dist/index.js";

test("Gemini is registered with native chat, automatic cache, and Gemini usage capabilities", () => {
  assert.equal(PROVIDER_TYPE_SET.has("gemini"), true);
  assert.deepEqual(providerTypeSpec("gemini"), {
    type: "gemini",
    defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
    chatKind: "gemini",
    promptCacheMode: "automatic_prefix",
    usageFormat: "gemini",
    supportsPromptCacheKey: false,
    supportsPromptCacheTtl: false,
    exposesPromptCacheToggle: false,
    supportsStreamUsageOptions: false,
    nativeFunctionCalling: "configurable",
  });
  // 注册表封闭为 5 种纯协议格式；厂商专属类型已移除（适配在 provider 层声明）
  assert.equal(PROVIDER_TYPE_SET.has("mistral"), false);
  assert.equal(PROVIDER_TYPE_SET.has("qwen"), false);
  assert.equal(PROVIDER_TYPE_SET.has("deepseek"), false);
  assert.equal(providerUsesNativeFunctionCalling("gemini", true), true);
  assert.equal(providerUsesNativeFunctionCalling("gemini", false), false);
  assert.equal(providerUsesNativeFunctionCalling("anthropic", false), true);
});

test("Gemini continuation parser preserves candidate parts", () => {
  const parts = [{ functionCall: { id: "call-1", name: "read_file", args: { path: "README.md" } }, thoughtSignature: "sig" }];
  assert.deepEqual(parseProviderContinuationState({
    protocol: "gemini_generate_content",
    toolCallIds: ["call-1"],
    parts,
  }), {
    protocol: "gemini_generate_content",
    toolCallIds: ["call-1"],
    parts,
  });
});
