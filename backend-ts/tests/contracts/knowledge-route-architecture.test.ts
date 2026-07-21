import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("knowledge route architecture", () => {
  it("uses one knowledge application without deployment or adapter branching", () => {
    const source = fs.readFileSync(path.resolve("src/routes/knowledge-base.ts"), "utf8");
    expect(source).not.toMatch(/deploymentKind|storage\.kind|container\.local|requireLocalRuntime/);
    expect(source).not.toMatch(/resolveKnowledge(FileStore|MarkdownPipeline|VectorApplication)/);
    expect(source).toContain("resolveKnowledgeApplication");
  });
});
