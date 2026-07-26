import { describe, expect, it } from "vitest";

import { resolveSandboxPath, validateSandboxGlob } from "../../../../src/adapters/saas/sandbox/sandbox-paths.js";

describe("sandbox path policy", () => {
  it("maps managed spaces to fixed sandbox roots", () => {
    expect(resolveSandboxPath("report.csv", { explicitSpace: "uploads", operation: "read" }).internalPath).toBe("/input/uploads/report.csv");
    expect(resolveSandboxPath("workspace/src/a.ts", { operation: "read" }).internalPath).toBe("/work/src/a.ts");
    expect(resolveSandboxPath("result.csv", { explicitSpace: "exports", operation: "write" }).internalPath).toBe("/output/result.csv");
  });

  it.each(["../secret", "a/../../secret", "/etc/passwd", "C:\\Users\\secret", "\\\\server\\share"])("rejects unsafe path %s", (unsafe) => {
    expect(() => resolveSandboxPath(unsafe, { operation: "read" })).toThrow();
  });

  it("keeps input/uploads read-only", () => {
    expect(() => resolveSandboxPath("a.txt", { explicitSpace: "uploads", operation: "write" })).toThrow("只读");
    expect(() => resolveSandboxPath("input/a.txt", { operation: "write" })).toThrow("只读");
  });

  it("rejects traversal in glob roots", () => {
    expect(() => validateSandboxGlob("../**/*")).toThrow("..");
  });
});
