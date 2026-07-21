import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../../src");

describe("request application composition", () => {
  it("keeps deployment selection and Local adapters out of request resolution", () => {
    const source = fs.readFileSync(path.join(sourceRoot, "app/request-applications.ts"), "utf8");
    expect(source).not.toContain("deploymentKind");
    expect(source).not.toContain("adapters/local");
    expect(source).not.toContain("new Local");
    expect(source).toContain("resolveExecutionApplication");
  });

  it("forwards the complete resolver set to HTTP and realtime scopes", () => {
    const source = fs.readFileSync(path.join(sourceRoot, "app/route-assembly.ts"), "utf8");
    for (const resolver of [
      "resolveSessionApplication", "resolveMemoryApplication", "resolveArtifactApplication",
      "resolveAnalytics", "resolveMonitoringApplication", "resolveExecutionRead", "resolveExecutionApplication",
    ]) {
      expect(source).toContain(`${resolver}: options.${resolver}`);
    }
    expect(source).toContain("...applicationResolvers");
  });

  it("binds the SaaS execution application in the production composition root", () => {
    const source = fs.readFileSync(path.join(sourceRoot, "main.ts"), "utf8");
    expect(source).toContain("resolveExecutionApplication:");
    expect(source).toContain("new RuntimeExecutionApplication");
  });
});
