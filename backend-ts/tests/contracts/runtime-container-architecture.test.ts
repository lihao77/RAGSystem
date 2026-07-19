import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("runtime container architecture", () => {
  it("does not bind the shared runtime contract to deployment adapters", async () => {
    const source = await readFile(resolve(process.cwd(), "src/services/runtime/runtime-container-contracts.ts"), "utf8");
    expect(source).not.toContain("adapters/local");
    expect(source).not.toContain("adapters/saas");
  });
});
