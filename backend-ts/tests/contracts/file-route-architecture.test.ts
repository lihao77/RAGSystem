import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("file route application boundaries", () => {
  it.each(["session-files.ts", "file-changes.ts"])("keeps %s deployment-neutral", (name) => {
    const source = fs.readFileSync(path.resolve("src/routes/agent", name), "utf8");
    expect(source).not.toContain("requireLocalRuntime");
    expect(source).not.toContain("ensureRequestResources");
    expect(source).not.toContain("AsyncSessionFileStorage");
    expect(source).not.toContain("IFileIndexStore");
    expect(source).not.toContain("AsyncFileChangeService");
    expect(source).not.toContain("FileChangeService");
  });

  it("keeps file adapter selection out of shared route assembly", () => {
    const source = fs.readFileSync(path.resolve("src/app/route-assembly.ts"), "utf8");
    expect(source).not.toContain("LocalSessionFileApplication");
    expect(source).not.toContain("SaaSSessionFileApplication");
    expect(source).not.toContain("LocalFileChangeApplication");
    expect(source).not.toContain("SaaSFileChangeApplication");
  });
});
