import { describe, expect, it } from "vitest";

import {
  readPersistedSessionCacheTotals,
  SESSION_CACHE_TOTALS_METADATA_KEY,
} from "../src/services/agent/context-compression/input-token-tracker.js";

describe("session cache totals hydration", () => {
  it("returns null when the session has never recorded cache totals", () => {
    expect(readPersistedSessionCacheTotals({})).toBeNull();
    expect(readPersistedSessionCacheTotals({ [SESSION_CACHE_TOTALS_METADATA_KEY]: "corrupt" })).toBeNull();
  });

  it("keeps valid fields when a single field is corrupt", () => {
    // 单字段损坏（滚动升级旧写入/外部改写）只收敛该字段，保留其余有效累计，
    // 避免下一次累计从 0 重建把历史命中量静默清零。
    expect(readPersistedSessionCacheTotals({
      [SESSION_CACHE_TOTALS_METADATA_KEY]: {
        cached_input_tokens: 900,
        cache_creation_input_tokens: 100,
        input_tokens: "not-a-number",
      },
    })).toEqual({
      cachedInputTokens: 900,
      cacheCreationInputTokens: 100,
      inputTokens: 0,
    });
  });

  it("returns null only when every field is invalid", () => {
    expect(readPersistedSessionCacheTotals({
      [SESSION_CACHE_TOTALS_METADATA_KEY]: {
        cached_input_tokens: null,
        cache_creation_input_tokens: "x",
        input_tokens: -5,
      },
    })).toBeNull();
  });

  it("parses a well-formed entry", () => {
    expect(readPersistedSessionCacheTotals({
      [SESSION_CACHE_TOTALS_METADATA_KEY]: {
        cached_input_tokens: 900,
        input_tokens: 1200,
      },
    })).toEqual({
      cachedInputTokens: 900,
      cacheCreationInputTokens: 0,
      inputTokens: 1200,
    });
  });
});
