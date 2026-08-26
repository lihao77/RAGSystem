import type {
  MemoryAgentConfig,
  MemoryAgentConfigKey,
  MemoryAgentConfigStore,
} from "../../config.js";
import type { PostgresMemoryExecutor } from "./repository.js";

export class PostgresMemoryAgentConfigStore implements MemoryAgentConfigStore {
  constructor(
    private readonly executor: PostgresMemoryExecutor,
    private readonly tenantId: string,
  ) {}

  async get(key: MemoryAgentConfigKey): Promise<unknown | null> {
    const result = await this.executor.query<{ config: unknown }>(
      "SELECT config FROM memory_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return result.rows[0]?.config ?? null;
  }

  async put(key: MemoryAgentConfigKey, config: MemoryAgentConfig): Promise<void> {
    await this.executor.query(`
      INSERT INTO memory_agent_configs (tenant_id, team_name, agent_name, config)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (tenant_id, team_name, agent_name) DO UPDATE SET
        config = EXCLUDED.config,
        updated_at = CURRENT_TIMESTAMP
    `, [this.tenantId, key.teamName, key.agentName, JSON.stringify(config)]);
  }

  async delete(key: MemoryAgentConfigKey): Promise<boolean> {
    const result = await this.executor.query(
      "DELETE FROM memory_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  /** 删除 team（可选缩到单个 agent）名下的记忆配置；返回删除行数。 */
  async deleteByTarget(teamName: string, agentName?: string | null): Promise<number> {
    const sql = agentName
      ? "DELETE FROM memory_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3"
      : "DELETE FROM memory_agent_configs WHERE tenant_id = $1 AND team_name = $2";
    const params = agentName ? [this.tenantId, teamName, agentName] : [this.tenantId, teamName];
    const result = await this.executor.query(sql, params);
    return Number(result.rowCount ?? 0);
  }

  /** team 重命名：记忆配置行跟随迁移；返回更新行数。 */
  async renameTeam(previousTeamName: string, teamName: string): Promise<number> {
    const result = await this.executor.query(
      "UPDATE memory_agent_configs SET team_name = $3, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND team_name = $2",
      [this.tenantId, previousTeamName, teamName],
    );
    return Number(result.rowCount ?? 0);
  }
}
