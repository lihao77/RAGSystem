import type { McpServerConfig } from "@ragsystem/backend-core/contracts/integrations/mcp.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { ProviderMcpRepository } from "@ragsystem/backend-core/contracts/integrations/provider-mcp-repository.js";
import type { McpService } from "@ragsystem/backend-core/services/integrations/mcp-service.js";
import { SaaSMcpRuntimeRegistry } from "../../composition/saas-mcp-runtime.js";
import { toMcpServerConfig, toModelProviderConfig } from "./provider-config-mapping.js";

/** Tenant-scoped application facade for SaaS provider/MCP config (Postgres source of truth). */
export class SaaSProviderMcpApplication {
  private readonly runtimes = new SaaSMcpRuntimeRegistry(this);

  constructor(private readonly repository: ProviderMcpRepository) {}

  resolveMcpRuntime(tenantId: TenantId, options: { connect?: boolean } = {}): Promise<McpService> {
    return this.runtimes.resolve(tenantId, options);
  }

  /** Release tenant MCP connections when the tenant runtime is idle-closed. */
  dropMcpRuntime(tenantId: TenantId): void {
    this.runtimes.drop(tenantId);
  }

  close(): void {
    this.runtimes.close();
  }

  async listProviders(tenantId: TenantId): Promise<ModelProviderConfig[]> {
    const records = await this.repository.listProviders(tenantId);
    return records.map(toModelProviderConfig);
  }

  async listMcpServers(tenantId: TenantId): Promise<McpServerConfig[]> {
    const records = await this.repository.listMcpServers(tenantId);
    return records.map(toMcpServerConfig);
  }
}
