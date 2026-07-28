import type { DatabaseSync } from "node:sqlite";

import {
  SkillsAgentConfigSchema,
  type SkillsAgentConfig,
  type SkillsAgentConfigKey,
  type SkillsAgentConfigStore,
} from "../../config.js";

export class SqliteSkillsAgentConfigStore implements SkillsAgentConfigStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tenantId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_agent_configs (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name, agent_name)
      )
    `);
  }

  async get(key: SkillsAgentConfigKey): Promise<unknown | null> {
    const row = this.db.prepare(
      "SELECT config_json FROM skill_agent_configs WHERE tenant_id = ? AND team_name = ? AND agent_name = ?",
    ).get(this.tenantId, key.teamName, key.agentName) as { config_json: string } | undefined;
    return row ? JSON.parse(row.config_json) as unknown : null;
  }

  async put(key: SkillsAgentConfigKey, config: SkillsAgentConfig): Promise<void> {
    this.db.prepare(`
      INSERT INTO skill_agent_configs (tenant_id, team_name, agent_name, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, team_name, agent_name) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(this.tenantId, key.teamName, key.agentName, JSON.stringify(config));
  }

  async delete(key: SkillsAgentConfigKey): Promise<boolean> {
    const result = this.db.prepare(
      "DELETE FROM skill_agent_configs WHERE tenant_id = ? AND team_name = ? AND agent_name = ?",
    ).run(this.tenantId, key.teamName, key.agentName);
    return Number(result.changes) > 0;
  }

  async purgeSkillReference(skillName: string): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT team_name, agent_name, config_json FROM skill_agent_configs WHERE tenant_id = ?",
    ).all(this.tenantId) as Array<{ team_name: string; agent_name: string; config_json: string }>;
    const updated: string[] = [];
    const write = this.db.prepare(`
      UPDATE skill_agent_configs SET config_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ? AND team_name = ? AND agent_name = ?
    `);
    for (const row of rows) {
      const parsed = SkillsAgentConfigSchema.safeParse(JSON.parse(row.config_json) as unknown);
      if (!parsed.success || !parsed.data.enabled_skills.includes(skillName)) continue;
      write.run(
        JSON.stringify({ enabled_skills: parsed.data.enabled_skills.filter((name) => name !== skillName) }),
        this.tenantId,
        row.team_name,
        row.agent_name,
      );
      updated.push(`${row.team_name}/${row.agent_name}`);
    }
    return updated;
  }
}
