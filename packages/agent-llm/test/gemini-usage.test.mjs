import assert from "node:assert/strict";
import test from "node:test";

import { extractGeminiUsage } from "../dist/providers/gemini.js";

test("Gemini usage reports implicit cached prompt tokens", () => {
  assert.deepEqual(extractGeminiUsage({
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 120,
      thoughtsTokenCount: 30,
      totalTokenCount: 1150,
      cachedContentTokenCount: 970,
    },
  }), {
    inputTokens: 1000,
    outputTokens: 150,
    totalTokens: 1150,
    cachedInputTokens: 970,
  });
});

test("Gemini usage falls back to candidate plus thought tokens", () => {
  assert.deepEqual(extractGeminiUsage({
    usageMetadata: {
      promptTokenCount: 400,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 10,
    },
  }), {
    inputTokens: 400,
    outputTokens: 60,
    totalTokens: 460,
  });
});
