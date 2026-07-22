import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const compositionFile = (name: string) => resolve(
  process.cwd(),
  "src/adapters/saas/composition",
  name,
);
const sourceFile = (...parts: string[]) => resolve(process.cwd(), "src", ...parts);

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
    expect(source).not.toContain("null as unknown");
    expect(source).not.toContain("as unknown as");
    expect(source).not.toContain("ConversationStore");
    expect(source).not.toContain("IFileHistoryStore");
    expect(source).not.toContain("IFileIndexStore");
    expect(source).not.toContain("IMemoryStore");
    expect(source).toContain("capabilities: {");
    expect(source).toContain("eventDispatcher: outboxDispatcher");
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

  it("keeps Local-only repositories outside the shared core dependency surface", async () => {
    const source = await readFile(sourceFile("services", "runtime", "core-runtime-container.ts"), "utf8");

    expect(source).not.toContain("conversationStore");
    expect(source).not.toContain("knowledgeBase");
    expect(source).not.toContain("transientArtifacts");
    expect(source).not.toContain("memoryStore");
    expect(source).toContain("sessionFiles,");
    expect(source).not.toContain("sessionFiles.kind");
    expect(source).toContain("eventDispatcher");
  });
});
