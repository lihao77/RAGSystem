import type {
  KnowledgeAgentConfig,
  KnowledgeAgentConfigKey,
  KnowledgeAgentConfigStore,
} from "../../agent-config.js";
import type { KnowledgePostgresExecutor } from "./executor.js";

export class PostgresKnowledgeAgentConfigStore implements KnowledgeAgentConfigStore {
  constructor(
    private readonly executor: KnowledgePostgresExecutor,
    private readonly tenantId: string,
  ) {}

  async get(key: KnowledgeAgentConfigKey): Promise<unknown | null> {
    const result = await this.executor.query<{ config: unknown }>(
      "SELECT config FROM knowledge_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return result.rows[0]?.config ?? null;
  }

  async put(key: KnowledgeAgentConfigKey, config: KnowledgeAgentConfig): Promise<void> {
    await this.executor.query(`
      INSERT INTO knowledge_agent_configs (tenant_id, team_name, agent_name, config)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (tenant_id, team_name, agent_name) DO UPDATE SET
        config = EXCLUDED.config,
        updated_at = CURRENT_TIMESTAMP
    `, [this.tenantId, key.teamName, key.agentName, JSON.stringify(config)]);
  }

  async delete(key: KnowledgeAgentConfigKey): Promise<boolean> {
    const result = await this.executor.query(
      "DELETE FROM knowledge_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return Number(result.rowCount ?? 0) > 0;
  }
}
