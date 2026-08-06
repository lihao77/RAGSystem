import assert from "node:assert/strict";
import test from "node:test";

import { extractAnthropicUsage, extractOpenAiUsage } from "../dist/internal/usage.js";

test("OpenAI usage preserves logical input and exposes cached input details", () => {
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      prompt_tokens: 120,
      completion_tokens: 8,
      total_tokens: 128,
      prompt_tokens_details: { cached_tokens: 80 },
    },
  }), {
    inputTokens: 120,
    outputTokens: 8,
    totalTokens: 128,
    cachedInputTokens: 80,
  });
});

test("Anthropic usage sums uncached, cache-write, and cache-read input", () => {
  assert.deepEqual(extractAnthropicUsage({
    usage: {
      input_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 100,
      output_tokens: 9,
    },
  }), {
    inputTokens: 150,
    outputTokens: 9,
    totalTokens: 159,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 30,
  });
});

test("Anthropic output-only stream deltas do not fabricate input usage", () => {
  assert.deepEqual(extractAnthropicUsage({ usage: { output_tokens: 7 } }), {
    inputTokens: 0,
    outputTokens: 7,
    totalTokens: 7,
  });
});
