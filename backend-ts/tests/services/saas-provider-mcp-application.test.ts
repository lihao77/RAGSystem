import { describe, expect, it } from "vitest";

import { SaaSProviderMcpApplication } from "../../src/adapters/saas/application/provider-mcp/saas-provider-mcp-application.js";

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
      { key: "openai-main", api_key: "secret", model_map: { chat: "gpt-4o" }, models: ["gpt-4o"] },
    ]);
    await expect(app.listMcpServers("tenant-a")).resolves.toMatchObject([
      { name: "docs", transport: "streamable_http", url: "https://mcp.example.test" },
    ]);
  });
});
