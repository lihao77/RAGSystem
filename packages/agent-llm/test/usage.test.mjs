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

test("OpenAI-compatible usage exposes cache writes when reported", () => {
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      prompt_tokens: 150,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 30 },
    },
  }), {
    inputTokens: 150,
    outputTokens: 5,
    totalTokens: 155,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 30,
  });
});

test("DeepSeek usage maps cache hit and miss tokens", () => {
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 4,
    },
  }), {
    inputTokens: 100,
    outputTokens: 4,
    totalTokens: 104,
    cachedInputTokens: 90,
  });
});

test("Qwen-compatible usage maps cache creation tokens when reported", () => {
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 80,
      total_tokens: 1280,
      prompt_tokens_details: {
        cached_tokens: 1100,
        cache_creation_input_tokens: 100,
      },
    },
  }), {
    inputTokens: 1200,
    outputTokens: 80,
    totalTokens: 1280,
    cachedInputTokens: 1100,
    cacheCreationInputTokens: 100,
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
