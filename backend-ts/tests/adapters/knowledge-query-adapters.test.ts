import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("knowledge query adapters", () => {
  it("does not keep dual-path Local knowledge query adapter", () => {
    expect(fs.existsSync(path.resolve("src/adapters/local/local-knowledge-query-adapter.ts"))).toBe(false);
  });

  it("does not keep an empty SaaS passthrough knowledge query adapter", () => {
    expect(fs.existsSync(path.resolve("src/adapters/saas/postgres/knowledge-query-adapter.ts"))).toBe(false);
  });
});
