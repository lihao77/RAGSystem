import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const compositionFile = (name: string) => resolve(
  process.cwd(),
  "src/adapters/saas/composition",
  name,
);

describe("SaaS runtime architecture", () => {
  it("keeps the SaaS runtime composition independent from Local and SQLite factories", async () => {
    const source = await readFile(compositionFile("saas-runtime-container.ts"), "utf8");

    expect(source).not.toMatch(/from\s+["'][^"']*adapters\/local(?:\/|["'])/);
    expect(source).not.toMatch(/from\s+["'][^"']*\.\.\/\.\.\/local(?:\/|["'])/);
    expect(source).not.toContain("LocalRuntimeContainerOptions");
    expect(source).not.toContain("createLocalRuntimeContainer");
    expect(source).not.toContain("createConversationStore");
    expect(source).not.toContain("FileIndexService");
    expect(source).not.toContain("createVectorStoreFromConfig");
  });

  it("does not provision a tenant-local SQLite database from the SaaS registry", async () => {
    const source = await readFile(compositionFile("saas-tenant-runtime-registry.ts"), "utf8");

    expect(source).not.toMatch(/\bdbPath\b/);
    expect(source).not.toMatch(/ragsystem\.db/);
    expect(source).not.toContain("createLocalRuntimeContainer");
    expect(source).not.toContain("createConversationStore");
    expect(source).not.toContain("FileIndexService");
    expect(source).not.toContain("createVectorStoreFromConfig");
  });
});
