import { describe, expect, it } from "vitest";
import { createTenantId } from "../../../../src/identity/types.js";
import { PostgresProviderMcpRepository } from "../../../../src/adapters/saas/postgres/provider-mcp-repository.js";
import type { PostgresMemoryExecutor } from "../../../../src/adapters/saas/postgres/memory-repository.js";

function executor(rows: Record<string, unknown>[] = []): PostgresMemoryExecutor {
  return {
    query: async (sql: string) => ({ rows: sql.includes("saas_provider_configs") ? rows : rows, rowCount: 1 }),
    transaction: async (fn) => fn({} as PostgresMemoryExecutor),
  };
}

describe("PostgresProviderMcpRepository", () => {
  it("scopes provider reads and upserts by tenant", async () => {
    const tenant = createTenantId("tnt_one");
    const repo = new PostgresProviderMcpRepository(executor([{ tenant_id: tenant, provider_key: "openai", config: { name: "OpenAI" }, created_at: "2026-01-01", updated_at: "2026-01-01" }]));
    const item = await repo.getProvider(tenant, "openai");
    expect(item?.tenant_id).toBe(tenant);
    expect(item?.config).toEqual({ name: "OpenAI" });
  });

  it("maps MCP server JSON configuration", async () => {
    const tenant = createTenantId("tnt_one");
    const repo = new PostgresProviderMcpRepository(executor([{ tenant_id: tenant, server_name: "docs", config: { transport: "stdio" }, created_at: "2026-01-01", updated_at: "2026-01-01" }]));
    const item = await repo.getMcpServer(tenant, "docs");
    expect(item?.server_name).toBe("docs");
    expect(item?.config.transport).toBe("stdio");
  });
});
