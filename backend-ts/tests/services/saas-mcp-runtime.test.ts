import { describe, expect, it } from "vitest";

import { SaaSMcpRuntimeRegistry } from "../../src/adapters/saas/composition/saas-mcp-runtime.js";

describe("SaaSMcpRuntimeRegistry", () => {
  it("hydrates isolated tenant runtimes from the SaaS config application", async () => {
    const configs = new Map<string, Array<Record<string, unknown>>>([
      ["tenant-a", [{ name: "docs", transport: "streamable_http", url: "https://a.test/mcp", enabled: true, auto_connect: false }]],
      ["tenant-b", [{ name: "search", transport: "streamable_http", url: "https://b.test/mcp", enabled: true, auto_connect: false }]],
    ]);
    const application = {
      listMcpServers: async (tenantId: string) => configs.get(tenantId) ?? [],
    };
    const registry = new SaaSMcpRuntimeRegistry(application as never);

    const tenantA = await registry.resolve("tenant-a" as never);
    const tenantB = await registry.resolve("tenant-b" as never);
    expect(tenantA.listServers().map((server) => server.name)).toEqual(["docs"]);
    expect(tenantB.listServers().map((server) => server.name)).toEqual(["search"]);

    configs.set("tenant-a", [{ name: "wiki", transport: "streamable_http", url: "https://wiki.test/mcp", enabled: true, auto_connect: false }]);
    await registry.resolve("tenant-a" as never);
    expect(tenantA.listServers().map((server) => server.name)).toEqual(["wiki"]);
    expect(tenantB.listServers().map((server) => server.name)).toEqual(["search"]);
    registry.close();
  });
});
