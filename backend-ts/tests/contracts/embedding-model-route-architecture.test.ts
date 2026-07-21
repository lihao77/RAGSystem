import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("embedding model route architecture", () => {
  it("depends on the shared knowledge application and never on Local runtime capabilities", () => {
    const source = fs.readFileSync(path.resolve("src/routes/embedding-models.ts"), "utf8");
    expect(source).toContain("resolveKnowledgeApplication");
    expect(source).not.toContain("requireLocalRuntime");
    expect(source).not.toContain("request.container.local");
  });
});
