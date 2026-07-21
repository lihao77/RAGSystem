import { afterEach, describe, expect, it } from "vitest";

import { LocalMcpApplication } from "../../src/adapters/local/application/mcp/local-mcp-application.js";
import { LocalProviderApplication } from "../../src/adapters/local/application/provider/local-provider-application.js";
import { SaaSMcpApplication } from "../../src/adapters/saas/application/provider-mcp/saas-mcp-application.js";
import { SaaSProviderApplication } from "../../src/adapters/saas/application/provider-mcp/saas-provider-application.js";
import { SaaSProviderMcpApplication } from "../../src/adapters/saas/application/provider-mcp/saas-provider-mcp-application.js";
import type {
  McpServerRecord,
  ProviderConfigRecord,
  ProviderMcpRepository,
} from "../../src/contracts/integrations/provider-mcp-repository.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { McpService } from "../../src/services/integrations/mcp-service.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";

const closeables: Array<() => void> = [];

afterEach(() => {
  for (const close of closeables.splice(0)) close();
});

describe("provider/MCP application contract", () => {
  it("uses the same provider business rules for Local and SaaS", async () => {
    const repository = new MemoryProviderMcpRepository();
    const local = new LocalProviderApplication(new ModelAdapterService({ providersConfigPath: "" }));
    const saas = new SaaSProviderApplication(
      LOCAL_TENANT_ID,
      new ModelAdapterService({ providersConfigPath: "" }),
      repository,
    );
    const payload = {
      name: "Main",
      provider_type: "openai",
      api_mode: "responses",
      api_key: "sk-test",
      model: "gpt-4.1",
    };

    expect(await local.createProvider(payload)).toBe("main_openai_resp");
    expect(await saas.createProvider(payload)).toBe("main_openai_resp");
    expect(await saas.listProviders()).toEqual(await local.listProviders());
    expect(repository.providers.get("main_openai_resp")?.config).toMatchObject({
      name: "Main",
      provider_type: "openai_resp",
      models: ["gpt-4.1"],
    });
  });

  it("keeps Local and SaaS MCP configuration behavior aligned", async () => {
    const repository = new MemoryProviderMcpRepository();
    const localService = new McpService({ configPath: "" });
    const local = new LocalMcpApplication(localService);
    const config = new SaaSProviderMcpApplication(repository);
    const saas = new SaaSMcpApplication(LOCAL_TENANT_ID, config, repository);
    closeables.push(() => localService.close(), () => config.close());
    const payload = {
      name: "filesystem",
      display_name: "Filesystem",
      transport: "stdio" as const,
      command: process.execPath,
      args: ["server.cjs"],
      env: {},
      url: null,
      headers: {},
      enabled: true,
      auto_connect: false,
      timeout: 30,
      risk_level: "medium",
      tool_risk_overrides: {},
      trusted: true,
    };

    expect(await local.addServer(payload)).toEqual({ name: "filesystem" });
    expect(await saas.addServer(payload)).toEqual({ name: "filesystem" });
    expect((await saas.listServers())[0]).toMatchObject(pickObservableServer((await local.listServers())[0]!));

    const update = {
      display_name: "Filesystem Updated",
      transport: "stdio" as const,
      command: process.execPath,
      args: ["server.cjs"],
      env: {},
      url: null,
      headers: {},
      enabled: false,
      auto_connect: false,
      timeout: 30,
      risk_level: "medium",
      tool_risk_overrides: {},
      trusted: true,
    };
    await local.updateServer("filesystem", update);
    await saas.updateServer("filesystem", update);
    expect((await saas.listServers())[0]).toMatchObject(pickObservableServer((await local.listServers())[0]!));

    await local.deleteServer("filesystem");
    await saas.deleteServer("filesystem");
    expect(await local.listServers()).toEqual([]);
    expect(await saas.listServers()).toEqual([]);
  });

  it("restores the SaaS MCP runtime when PostgreSQL persistence fails", async () => {
    const repository = new FailingMcpRepository();
    const config = new SaaSProviderMcpApplication(repository);
    const saas = new SaaSMcpApplication(LOCAL_TENANT_ID, config, repository);
    closeables.push(() => config.close());
    const payload = {
      name: "filesystem", display_name: "Before", transport: "stdio" as const,
      command: process.execPath, args: ["server.cjs"], env: {}, url: null, headers: {},
      enabled: false, auto_connect: false, timeout: 30, risk_level: "medium",
      tool_risk_overrides: {}, trusted: true,
    };
    await saas.addServer(payload);
    repository.failWrites = true;

    await expect(saas.updateServer("filesystem", { ...payload, display_name: "After" })).rejects.toThrow("write failed");
    expect((await saas.listServers())[0]).toMatchObject({ name: "filesystem", display_name: "Before" });
  });
});

function pickObservableServer(server: Record<string, unknown>) {
  return {
    name: server.name,
    display_name: server.display_name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    enabled: server.enabled,
    auto_connect: server.auto_connect,
    status: server.status,
    tool_count: server.tool_count,
  };
}

class MemoryProviderMcpRepository implements ProviderMcpRepository {
  readonly providers = new Map<string, ProviderConfigRecord>();
  readonly servers = new Map<string, McpServerRecord>();

  async listProviders() { return [...this.providers.values()]; }
  async getProvider(_tenantId: typeof LOCAL_TENANT_ID, key: string) { return this.providers.get(key) ?? null; }
  async upsertProvider(tenantId: typeof LOCAL_TENANT_ID, key: string, config: Record<string, unknown>) {
    const value = providerRecord(tenantId, key, config);
    this.providers.set(key, value);
    return value;
  }
  async deleteProvider(_tenantId: typeof LOCAL_TENANT_ID, key: string) { return this.providers.delete(key); }
  async reorderProviders(_tenantId: typeof LOCAL_TENANT_ID, keys: string[]) {
    if (keys.some((key) => !this.providers.has(key))) return false;
    const ordered = keys.map((key) => [key, this.providers.get(key)!] as const);
    this.providers.clear();
    for (const [key, value] of ordered) this.providers.set(key, value);
    return true;
  }
  async listMcpServers() { return [...this.servers.values()]; }
  async getMcpServer(_tenantId: typeof LOCAL_TENANT_ID, name: string) { return this.servers.get(name) ?? null; }
  async upsertMcpServer(tenantId: typeof LOCAL_TENANT_ID, name: string, config: Record<string, unknown>) {
    const value = serverRecord(tenantId, name, config);
    this.servers.set(name, value);
    return value;
  }
  async deleteMcpServer(_tenantId: typeof LOCAL_TENANT_ID, name: string) { return this.servers.delete(name); }
}

class FailingMcpRepository extends MemoryProviderMcpRepository {
  failWrites = false;
  override async upsertMcpServer(tenantId: typeof LOCAL_TENANT_ID, name: string, config: Record<string, unknown>) {
    if (this.failWrites) throw new Error("write failed");
    return super.upsertMcpServer(tenantId, name, config);
  }
}

function providerRecord(tenantId: typeof LOCAL_TENANT_ID, key: string, config: Record<string, unknown>): ProviderConfigRecord {
  const now = new Date().toISOString();
  return { tenant_id: tenantId, provider_key: key, config: structuredClone(config), created_at: now, updated_at: now };
}

function serverRecord(tenantId: typeof LOCAL_TENANT_ID, name: string, config: Record<string, unknown>): McpServerRecord {
  const now = new Date().toISOString();
  return { tenant_id: tenantId, server_name: name, config: structuredClone(config), created_at: now, updated_at: now };
}
