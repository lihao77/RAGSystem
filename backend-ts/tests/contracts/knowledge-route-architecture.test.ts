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

  it("composes the same HTTP workflow for Local and SaaS", () => {
    const local = fs.readFileSync(path.resolve("src/adapters/local/application/local-request-application-resolvers.ts"), "utf8");
    const saas = fs.readFileSync(path.resolve("src/main.ts"), "utf8");
    expect(local).toContain("new KnowledgeHttpApplication(");
    expect(saas).toContain("new KnowledgeHttpApplication(");
    expect(fs.existsSync(path.resolve("src/adapters/local/application/knowledge/local-knowledge-application.ts"))).toBe(false);
    expect(fs.existsSync(path.resolve("src/adapters/saas/application/knowledge/saas-knowledge-application.ts"))).toBe(false);
    expect(fs.existsSync(path.resolve("src/adapters/saas/application/knowledge/saas-knowledge-vector-application.ts"))).toBe(false);
  });
});
