import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("runtime container architecture", () => {
  it("does not bind the shared runtime contract to deployment adapters", async () => {
    const source = await readFile(resolve(process.cwd(), "src/contracts/runtime/runtime-container.ts"), "utf8");
    expect(source).not.toContain("adapters/local");
    expect(source).not.toContain("adapters/saas");
  });

  it("keeps core runtime composition deployment-neutral", async () => {
    const source = await readFile(resolve(process.cwd(), "src/services/runtime/core-runtime-container.ts"), "utf8");
    expect(source).not.toMatch(/adapters\/(?:local|saas)/);
    expect(source).not.toMatch(/create(?:Local|Postgres)ExecutionStorage/);
    expect(source).not.toContain("CodeExecutionToolService");
    expect(source).not.toContain("LocalBashToolService");
    expect(source).not.toContain("LocalDocumentToolService");
    expect(source).not.toContain("LocalSearchToolService");
  });
});
