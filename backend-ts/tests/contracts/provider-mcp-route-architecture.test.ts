import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../../src");

describe("provider and MCP route architecture", () => {
  it("keeps deployment selection out of shared routes", () => {
    for (const file of ["routes/model-adapter.ts", "routes/mcp.ts"]) {
      const source = fs.readFileSync(path.join(sourceRoot, file), "utf8");
      expect(source).not.toMatch(/deploymentKind|storage\.kind|container\.local|resolveProviderMcp|container\.mcp/);
    }
  });

  it("exposes one application resolver for each route family", () => {
    const options = fs.readFileSync(path.join(sourceRoot, "routes/route-options.ts"), "utf8");
    expect(options).toContain("resolveProviderApplication");
    expect(options).toContain("resolveMcpApplication");
    expect(options).not.toContain("resolveProviderMcp");
  });

  it("forwards both applications to HTTP and realtime scopes and shares the SaaS MCP runtime", () => {
    const assembly = fs.readFileSync(path.join(sourceRoot, "app/route-assembly.ts"), "utf8");
    expect(assembly.match(/resolveProviderApplication: options\.resolveProviderApplication/g)?.length).toBeGreaterThanOrEqual(2);
    expect(assembly.match(/resolveMcpApplication: options\.resolveMcpApplication/g)?.length).toBeGreaterThanOrEqual(2);

    const composition = fs.readFileSync(path.join(sourceRoot, "adapters/saas/composition/saas-runtime-container.ts"), "utf8");
    expect(composition).not.toContain("new McpService");
    expect(composition).toContain("providerMcpApplication.resolveMcpRuntime(tenantId)");
  });
});
