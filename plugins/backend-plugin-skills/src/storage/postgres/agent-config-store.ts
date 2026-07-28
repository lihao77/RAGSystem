import {
  SkillsAgentConfigSchema,
  type SkillsAgentConfig,
  type SkillsAgentConfigKey,
  type SkillsAgentConfigStore,
} from "../../config.js";
import type { SkillsPostgresExecutor } from "./executor.js";

export class PostgresSkillsAgentConfigStore implements SkillsAgentConfigStore {
  constructor(
    private readonly executor: SkillsPostgresExecutor,
    private readonly tenantId: string,
  ) {}

  async get(key: SkillsAgentConfigKey): Promise<unknown | null> {
    const result = await this.executor.query<{ config: unknown }>(
      "SELECT config FROM skill_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return result.rows[0]?.config ?? null;
  }

  async put(key: SkillsAgentConfigKey, config: SkillsAgentConfig): Promise<void> {
    await this.executor.query(`
      INSERT INTO skill_agent_configs (tenant_id, team_name, agent_name, config)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (tenant_id, team_name, agent_name) DO UPDATE SET
        config = EXCLUDED.config,
        updated_at = CURRENT_TIMESTAMP
    `, [this.tenantId, key.teamName, key.agentName, JSON.stringify(config)]);
  }

  async delete(key: SkillsAgentConfigKey): Promise<boolean> {
    const result = await this.executor.query(
      "DELETE FROM skill_agent_configs WHERE tenant_id = $1 AND team_name = $2 AND agent_name = $3",
      [this.tenantId, key.teamName, key.agentName],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async purgeSkillReference(skillName: string): Promise<string[]> {
    return this.executor.transaction(async (tx) => {
      const result = await tx.query<{ team_name: string; agent_name: string; config: unknown }>(
        "SELECT team_name, agent_name, config FROM skill_agent_configs WHERE tenant_id = $1 FOR UPDATE",
        [this.tenantId],
      );
      const updated: string[] = [];
      for (const row of result.rows) {
        const parsed = SkillsAgentConfigSchema.safeParse(row.config);
        if (!parsed.success || !parsed.data.enabled_skills.includes(skillName)) continue;
        await tx.query(`
          UPDATE skill_agent_configs SET config = $1::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $2 AND team_name = $3 AND agent_name = $4
        `, [
          JSON.stringify({ enabled_skills: parsed.data.enabled_skills.filter((name) => name !== skillName) }),
          this.tenantId,
          row.team_name,
          row.agent_name,
        ]);
        updated.push(`${row.team_name}/${row.agent_name}`);
      }
      return updated;
    });
  }
}
