import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number;
}

export interface PostgresMcpExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
  transaction<T>(fn: (executor: PostgresMcpExecutor) => Promise<T>): Promise<T>;
}

export interface McpServerRecord {
  tenant_id: TenantId;
  server_name: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface McpRepository {
  listMcpServers(tenantId: TenantId): Promise<McpServerRecord[]>;
  getMcpServer(tenantId: TenantId, name: string): Promise<McpServerRecord | null>;
  upsertMcpServer(tenantId: TenantId, name: string, config: Record<string, unknown>): Promise<McpServerRecord>;
  deleteMcpServer(tenantId: TenantId, name: string): Promise<boolean>;
}

export class PostgresMcpRepository implements McpRepository {
  constructor(
    private readonly executor: PostgresMcpExecutor,
    private readonly secrets?: SecretResolver,
  ) {}

  async listMcpServers(tenantId: TenantId): Promise<McpServerRecord[]> {
    const result = await this.executor.query("SELECT * FROM saas_mcp_servers WHERE tenant_id=$1 ORDER BY server_name", [tenantId]);
    return Promise.all(result.rows.map((row) => this.hydrate(record(row))));
  }

  async getMcpServer(tenantId: TenantId, name: string): Promise<McpServerRecord | null> {
    const result = await this.executor.query("SELECT * FROM saas_mcp_servers WHERE tenant_id=$1 AND server_name=$2", [tenantId, name]);
    return result.rows[0] ? this.hydrate(record(result.rows[0])) : null;
  }

  async upsertMcpServer(
    tenantId: TenantId,
    name: string,
    config: Record<string, unknown>,
  ): Promise<McpServerRecord> {
    const prepared = await this.prepare(tenantId, name, config);
    const result = await this.executor.query(
      "INSERT INTO saas_mcp_servers(tenant_id,server_name,config) VALUES($1,$2,$3::jsonb) ON CONFLICT (tenant_id,server_name) DO UPDATE SET config=EXCLUDED.config,updated_at=CURRENT_TIMESTAMP RETURNING *",
      [tenantId, name, JSON.stringify(prepared)],
    );
    return this.hydrate(record(result.rows[0]!));
  }

  async deleteMcpServer(tenantId: TenantId, name: string): Promise<boolean> {
    const result = await this.executor.query("DELETE FROM saas_mcp_servers WHERE tenant_id=$1 AND server_name=$2", [tenantId, name]);
    return Number(result.rowCount ?? 0) > 0;
  }

  private async prepare(
    tenantId: TenantId,
    resourceId: string,
    config: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const copy = structuredClone(config);
    for (const item of collectSecrets(copy)) {
      if (!this.secrets) throw new Error("MCP secret resolver is required for sensitive configuration");
      await this.secrets.mutate(
        { tenantId, purpose: "mcp", resourceId, field: item.field },
        { kind: "set", value: item.value },
      );
      setPath(copy, item.path, { __secret_ref: item.field });
    }
    return copy;
  }

  private async hydrate(value: McpServerRecord): Promise<McpServerRecord> {
    const copy = structuredClone(value.config);
    for (const item of collectRefs(copy)) {
      if (!this.secrets) throw new Error("MCP secret resolver is required to read sensitive configuration");
      setPath(copy, item.path, await this.secrets.resolve({
        tenantId: value.tenant_id,
        purpose: "mcp",
        resourceId: value.server_name,
        field: item.field,
      }) ?? "");
    }
    return { ...value, config: copy };
  }
}

function record(row: Record<string, unknown>): McpServerRecord {
  return {
    tenant_id: row.tenant_id as TenantId,
    server_name: String(row.server_name),
    config: (row.config ?? {}) as Record<string, unknown>,
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

type SecretItem = { path: string[]; field: string; value: string };
const SECRET_KEY = /(^|_)(api[-_]?key|token|secret|password|authorization|private[-_]?key)$/i;

function collectSecrets(value: unknown, path: string[] = []): SecretItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result: SecretItem[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = [...path, key];
    if (typeof child === "string" && (SECRET_KEY.test(key) || path.includes("env") || path.includes("headers"))) {
      result.push({ path: next, field: `config.${next.join(".")}`, value: child });
    } else {
      result.push(...collectSecrets(child, next));
    }
  }
  return result;
}

function collectRefs(value: unknown, path: string[] = []): Array<{ path: string[]; field: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result: Array<{ path: string[]; field: string }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = [...path, key];
    if (child && typeof child === "object" && !Array.isArray(child) && "__secret_ref" in child) {
      result.push({ path: next, field: String((child as { __secret_ref: unknown }).__secret_ref) });
    } else {
      result.push(...collectRefs(child, next));
    }
  }
  return result;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}
