import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("Local adapter architecture", () => {
  it("keeps the analytics facade under adapters/local and free of SaaS imports", async () => {
    const file = resolve(process.cwd(), "src/adapters/local/local-analytics-application.ts");
    const source = await readFile(file, "utf8");
    expect(source).not.toContain("adapters/saas");
    expect(source).not.toContain("services/runtime/saas-");
    expect(source).toContain("AnalyticsApplication");
  });
});
