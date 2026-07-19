import { describe, expect, it } from "vitest";

import { MemoryStore as LocalMemoryStore } from "../../src/adapters/local/memory-store.js";
import { MemoryStore as LegacyMemoryStore } from "../../src/adapters/local/memory-store.js";

describe("local memory adapter exports", () => {
  it("keeps the legacy store import as an alias of the local adapter", () => {
    expect(LegacyMemoryStore).toBe(LocalMemoryStore);
  });
});
