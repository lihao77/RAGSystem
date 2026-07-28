import type { SystemConfigData } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import type { ISystemConfigStore } from "@ragsystem/backend-core/contracts/runtime/system-config-store.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import type { PostgresExecutor } from "./postgres-executor.js";

/** Tenant-scoped PostgreSQL persistence for system configuration. */
export class PostgresSystemConfigStore implements ISystemConfigStore {
  constructor(
    private readonly tenantId: TenantId,
    private readonly executor: PostgresExecutor,
  ) {}

  async load(): Promise<SystemConfigData | null> {
    const result = await this.executor.query(
      "SELECT config FROM saas_system_configs WHERE tenant_id=$1",
      [this.tenantId],
    );
    const raw = result.rows[0]?.config;
    if (!isRecord(raw)) {
      return null;
    }
    return structuredClone(raw) as SystemConfigData;
  }

  async save(config: SystemConfigData): Promise<void> {
    await this.executor.query(
      `INSERT INTO saas_system_configs(tenant_id, config)
       VALUES($1, $2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE
       SET config = EXCLUDED.config,
           updated_at = CURRENT_TIMESTAMP`,
      [this.tenantId, JSON.stringify(config)],
    );
  }
}
