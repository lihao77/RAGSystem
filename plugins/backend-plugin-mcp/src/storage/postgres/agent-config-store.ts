import type { McpAgentConfig, McpAgentConfigKey, McpAgentConfigStore } from "../../agent-config.js";
import type { PostgresMcpExecutor } from "./repository.js";

export class PostgresMcpAgentConfigStore implements McpAgentConfigStore {
  constructor(
    private readonly executor: PostgresMcpExecutor,
    private readonly tenantId: string,
  ) {}

  async get(key: McpAgentConfigKey): Promise<unknown | null> {
    const result = await this.executor.query<{ config: unknown }>(
      "SELECT config FROM mcp_agent_configs WHERE tenant_id=$1 AND team_name=$2 AND agent_name=$3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return result.rows[0]?.config ?? null;
  }

  async put(key: McpAgentConfigKey, config: McpAgentConfig): Promise<void> {
    await this.executor.query(`
      INSERT INTO mcp_agent_configs(tenant_id,team_name,agent_name,config)
      VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT (tenant_id,team_name,agent_name) DO UPDATE SET
        config=EXCLUDED.config,
        updated_at=CURRENT_TIMESTAMP
    `, [this.tenantId, key.teamName, key.agentName, JSON.stringify(config)]);
  }

  async delete(key: McpAgentConfigKey): Promise<boolean> {
    const result = await this.executor.query(
      "DELETE FROM mcp_agent_configs WHERE tenant_id=$1 AND team_name=$2 AND agent_name=$3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return Number(result.rowCount ?? 0) > 0;
  }
}
