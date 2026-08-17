import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_TYPE_SET,
  parseProviderContinuationState,
  providerEmbeddingDefaultEndpoint,
  providerTypeSpec,
  providerUsesNativeFunctionCalling,
} from "../dist/index.js";

test("Gemini is registered with native chat, automatic cache, and Gemini usage capabilities", () => {
  assert.equal(PROVIDER_TYPE_SET.has("gemini"), true);
  assert.deepEqual(providerTypeSpec("gemini"), {
    type: "gemini",
    defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
    chatKind: "gemini",
    supportsEmbedding: false,
    supportsRerank: false,
    promptCacheMode: "automatic_prefix",
    usageFormat: "gemini",
    supportsPromptCacheKey: false,
    supportsPromptCacheTtl: false,
    exposesPromptCacheToggle: false,
    supportsStreamUsageOptions: false,
    nativeFunctionCalling: "configurable",
  });
  assert.equal(providerTypeSpec("mistral").defaultEndpoint, "https://api.mistral.ai/v1");
  assert.equal(providerTypeSpec("groq").defaultEndpoint, "https://api.groq.com/openai/v1");
  assert.equal(providerTypeSpec("qwen").defaultEndpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerEmbeddingDefaultEndpoint("mistral"), "https://api.mistral.ai/v1");
  assert.equal(providerEmbeddingDefaultEndpoint("qwen"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerEmbeddingDefaultEndpoint("deepseek"), "");
  assert.equal(providerEmbeddingDefaultEndpoint("groq"), "");
  assert.equal(providerTypeSpec("openrouter").supportsRerank, true);
  assert.equal(providerTypeSpec("qwen").supportsRerank, false);
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
