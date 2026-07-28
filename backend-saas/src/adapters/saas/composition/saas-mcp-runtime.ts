import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { McpService } from "@ragsystem/backend-core/services/integrations/mcp-service.js";
import type { McpServerConfig } from "@ragsystem/backend-core/contracts/integrations/mcp.js";

interface SaaSMcpConfigSource {
  listMcpServers(tenantId: TenantId): Promise<McpServerConfig[]>;
}

/** Tenant-bound MCP connection state hydrated exclusively from PostgreSQL config. */
export class SaaSMcpRuntime {
  private readonly service = new McpService({ configPath: "" });
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly tenantId: TenantId,
    private readonly config: SaaSMcpConfigSource,
  ) {}

  async refresh(options: { connect?: boolean } = {}): Promise<McpService> {
    this.refreshPromise ??= this.synchronize().finally(() => { this.refreshPromise = null; });
    await this.refreshPromise;
    if (options.connect === true) await this.service.autoConnectEnabledServers();
    return this.service;
  }

  close(): void {
    this.service.close();
  }

  private async synchronize(): Promise<void> {
    const configured = await this.config.listMcpServers(this.tenantId);
    const desired = new Map(configured.map((server) => [server.name, server]));
    for (const current of this.service.listServers()) {
      if (!desired.has(current.name)) this.service.deleteServer(current.name);
    }
    for (const server of configured) {
      if (this.service.listServers().some((current) => current.name === server.name)) {
        await this.service.updateServer(server.name, server, { connect: false });
      } else {
        await this.service.addServer(server, { connect: false });
      }
    }
  }
}

export class SaaSMcpRuntimeRegistry {
  private readonly runtimes = new Map<TenantId, SaaSMcpRuntime>();

  constructor(private readonly config: SaaSMcpConfigSource) {}

  async resolve(tenantId: TenantId, options: { connect?: boolean } = {}): Promise<McpService> {
    let runtime = this.runtimes.get(tenantId);
    if (!runtime) {
      runtime = new SaaSMcpRuntime(tenantId, this.config);
      this.runtimes.set(tenantId, runtime);
    }
    return runtime.refresh(options);
  }

  /** Drop a tenant MCP runtime when the tenant container is idle-closed. */
  drop(tenantId: TenantId): void {
    const runtime = this.runtimes.get(tenantId);
    if (!runtime) return;
    runtime.close();
    this.runtimes.delete(tenantId);
  }

  size(): number {
    return this.runtimes.size;
  }

  close(): void {
    for (const runtime of this.runtimes.values()) runtime.close();
    this.runtimes.clear();
  }
}
