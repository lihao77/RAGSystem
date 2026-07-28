import type { DatabaseSync } from "node:sqlite";

import type {
  MemoryAgentConfig,
  MemoryAgentConfigKey,
  MemoryAgentConfigStore,
} from "../../config.js";

export class SqliteMemoryAgentConfigStore implements MemoryAgentConfigStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tenantId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_agent_configs (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name, agent_name)
      )
    `);
  }

  async get(key: MemoryAgentConfigKey): Promise<unknown | null> {
    const row = this.db.prepare(
      "SELECT config_json FROM memory_agent_configs WHERE tenant_id = ? AND team_name = ? AND agent_name = ?",
    ).get(this.tenantId, key.teamName, key.agentName) as { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json) as unknown : null;
  }

  async put(key: MemoryAgentConfigKey, config: MemoryAgentConfig): Promise<void> {
    this.db.prepare(`
      INSERT INTO memory_agent_configs (tenant_id, team_name, agent_name, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, team_name, agent_name) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(this.tenantId, key.teamName, key.agentName, JSON.stringify(config));
  }

  async delete(key: MemoryAgentConfigKey): Promise<boolean> {
    const result = this.db.prepare(
      "DELETE FROM memory_agent_configs WHERE tenant_id = ? AND team_name = ? AND agent_name = ?",
    ).run(this.tenantId, key.teamName, key.agentName);
    return Number(result.changes) > 0;
  }
}
