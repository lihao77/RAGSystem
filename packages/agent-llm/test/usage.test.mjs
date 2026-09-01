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

test("hit+miss outranks an input_tokens total that excludes cached input", () => {
  // 兼容网关病态形状：input_tokens 不含缓存部分，却又单独上报 hit/miss。
  // 分母必须取 hit+miss 完整分解，否则命中率虚高（90/10 = 900%）。
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      input_tokens: 10,
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

test("hit-only usage without miss falls back to the reported prompt total", () => {
  // 只报 hit 不报 miss 时无法重构总量，回到网关自报的 prompt_tokens（含缓存的口径）。
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 90,
      completion_tokens: 4,
    },
  }), {
    inputTokens: 100,
    outputTokens: 4,
    totalTokens: 104,
    cachedInputTokens: 90,
  });
});

test("cached-only round without a top-level input total floors input at the cache detail", () => {
  // 实测网关形状：usage 只带 input_tokens_details.cached_tokens 与 output_tokens，
  // 缺顶层 input_tokens/prompt_tokens。输入必须至少计入缓存部分，否则该轮
  // 分子加 cached、分母加 0，会话命中率会超过 100%。
  assert.deepEqual(extractOpenAiUsage({
    usage: {
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 9728 },
    },
  }), {
    inputTokens: 9728,
    outputTokens: 4,
    totalTokens: 9732,
    cachedInputTokens: 9728,
  });
});

test("reported input total below the cache detail is raised to the cache floor", () => {
  // 网关把 input_tokens 报成不含缓存部分的小值：输入抬升到 cached+write 下限。
  const parsed = extractOpenAiUsage({
    usage: {
      input_tokens: 500,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 9728, cache_write_tokens: 30 },
    },
  });
  assert.equal(parsed.inputTokens, 9758);
  assert.equal(parsed.cachedInputTokens, 9728);
  assert.equal(parsed.cacheCreationInputTokens, 30);
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
