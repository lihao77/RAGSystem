import { describe, expect, it } from "vitest";

import { SaaSProviderMcpApplication } from "../../src/services/runtime/saas-provider-mcp-application.js";

describe("SaaSProviderMcpApplication", () => {
  it("reads tenant-scoped provider and MCP records without filesystem config", async () => {
    const repository = {
      listProviders: async () => [{
        tenant_id: "tenant-a",
        provider_key: "openai-main",
        config: { name: "OpenAI", provider_type: "openai_chat", model_map: { chat: "gpt-4o" }, api_key: "secret" },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
      listMcpServers: async () => [{
        tenant_id: "tenant-a",
        server_name: "docs",
        config: { transport: "streamable_http", url: "https://mcp.example.test", headers: { authorization: "secret" } },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
    };

    const app = new SaaSProviderMcpApplication(repository as never);
    await expect(app.listProviders("tenant-a")).resolves.toMatchObject([
      { key: "openai-main", model_map: { chat: "gpt-4o" }, models: ["gpt-4o"] },
    ]);
    await expect(app.listMcpServers("tenant-a")).resolves.toMatchObject([
      { name: "docs", transport: "streamable_http", url: "https://mcp.example.test" },
    ]);
  });

  it("writes provider and MCP configuration through the tenant-scoped repository", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const repository = {
      getProvider: async () => null,
      upsertProvider: async (...args: unknown[]) => { calls.push(["upsertProvider", ...args]); return {}; },
      deleteProvider: async (...args: unknown[]) => { calls.push(["deleteProvider", ...args]); return true; },
      listProviders: async () => [{ provider_key: "main_openai_chat" }],
      reorderProviders: async (...args: unknown[]) => { calls.push(["reorderProviders", ...args]); return true; },
      getMcpServer: async () => null,
      upsertMcpServer: async (...args: unknown[]) => { calls.push(["upsertMcpServer", ...args]); return {}; },
      deleteMcpServer: async (...args: unknown[]) => { calls.push(["deleteMcpServer", ...args]); return true; },
    };
    const app = new SaaSProviderMcpApplication(repository as never);

    await expect(app.createProvider("tenant-a", { name: "Main", provider_type: "openai_chat", api_key: "secret" })).resolves.toBe("main_openai_chat");
    await expect(app.reorderProviders("tenant-a", ["main_openai_chat"])).resolves.toEqual(["main_openai_chat"]);
    await app.deleteProvider("tenant-a", "main_openai_chat");
    await expect(app.createMcpServer("tenant-a", { name: "docs" })).resolves.toEqual({ name: "docs" });
    await app.deleteMcpServer("tenant-a", "docs");

    expect(calls).toContainEqual(["deleteProvider", "tenant-a", "main_openai_chat"]);
    expect(calls).toContainEqual(["reorderProviders", "tenant-a", ["main_openai_chat"]]);
    expect(calls).toContainEqual(["deleteMcpServer", "tenant-a", "docs"]);
  });
});
