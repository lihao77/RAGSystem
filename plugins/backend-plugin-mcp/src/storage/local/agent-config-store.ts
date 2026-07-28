import type { DatabaseSync } from "node:sqlite";

import type { McpAgentConfig, McpAgentConfigKey, McpAgentConfigStore } from "../../agent-config.js";

export class SqliteMcpAgentConfigStore implements McpAgentConfigStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tenantId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_agent_configs (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name, agent_name)
      )
    `);
  }

  async get(key: McpAgentConfigKey): Promise<unknown | null> {
    const row = this.db.prepare(
      "SELECT config_json FROM mcp_agent_configs WHERE tenant_id = ? AND team_name = ? AND agent_name = ?",
    ).get(this.tenantId, key.teamName, key.agentName) as { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json) as unknown : null;
  }

  async put(key: McpAgentConfigKey, config: McpAgentConfig): Promise<void> {
    this.db.prepare(`
      INSERT INTO mcp_agent_configs (tenant_id, team_name, agent_name, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, team_name, agent_name) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(this.tenantId, key.teamName, key.agentName, JSON.stringify(config));
  }

  async delete(key: McpAgentConfigKey): Promise<boolean> {
    const result = this.db.prepare(
      "DELETE FROM mcp_agent_configs WHERE tenant_id = ? AND team_name = ? AND agent_name = ?",
    ).run(this.tenantId, key.teamName, key.agentName);
    return Number(result.changes) > 0;
  }
}
