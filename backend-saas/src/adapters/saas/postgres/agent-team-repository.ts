import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { AgentConfigSchema } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import {
  configsToRecord,
  normalizeConfig,
  normalizeTeamName,
} from "@ragsystem/backend-core/contracts/agent/config-normalize.js";
import type {
  AgentConfigTeam,
  IAgentConfigTeamStore,
  LoadedAgentConfigTeams,
} from "@ragsystem/backend-core/contracts/agent/team-store.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const AGENT_CONFIG_SCHEMA_VERSION = "2.0";

/** Tenant-scoped PostgreSQL persistence for agent team configuration. */
export class PostgresAgentConfigTeamStore implements IAgentConfigTeamStore {
  private readonly locationByName = new Map<string, string>();

  constructor(
    private readonly tenantId: TenantId,
    private readonly executor: PostgresMemoryExecutor,
  ) {}

  async loadTeams(): Promise<LoadedAgentConfigTeams | null> {
    const teamRows = await this.executor.query(
      "SELECT team_name, document, location FROM agent_teams WHERE tenant_id=$1 ORDER BY team_name",
      [this.tenantId],
    );
    if (teamRows.rows.length === 0) {
      this.locationByName.clear();
      return null;
    }

    const teams = new Map<string, AgentConfigTeam>();
    this.locationByName.clear();
    for (const row of teamRows.rows) {
      const teamName = normalizeTeamName(String(row.team_name));
      const configs = parseTeamDocument(row.document);
      if (!configs) continue;
      teams.set(teamName, configs);
      const location = typeof row.location === "string" && row.location.trim()
        ? row.location.trim()
        : syntheticTeamLocation(teamName);
      this.locationByName.set(teamName, location);
    }
    if (teams.size === 0) {
      return null;
    }

    const indexRows = await this.executor.query(
      "SELECT active_team FROM agent_team_index WHERE tenant_id=$1",
      [this.tenantId],
    );
    const activeRaw = typeof indexRows.rows[0]?.active_team === "string"
      ? String(indexRows.rows[0].active_team).trim()
      : "";
    return {
      activeTeam: activeRaw && teams.has(activeRaw)
        ? activeRaw
        : (Array.from(teams.keys()).sort()[0] ?? "default"),
      teams,
    };
  }

  async saveAll(activeTeam: string, teams: Map<string, AgentConfigTeam>): Promise<void> {
    this.ensureLocations(teams);
    await this.executor.transaction(async (tx) => {
      await this.upsertIndex(tx, activeTeam);
      const keepNames = Array.from(teams.keys());
      if (keepNames.length === 0) {
        await tx.query("DELETE FROM agent_teams WHERE tenant_id=$1", [this.tenantId]);
      } else {
        await tx.query(
          "DELETE FROM agent_teams WHERE tenant_id=$1 AND NOT (team_name = ANY($2::text[]))",
          [this.tenantId, keepNames],
        );
      }
      for (const [teamName, configs] of teams) {
        await this.upsertTeam(tx, teamName, configs);
      }
    });
  }

  async saveIndex(activeTeam: string, teams: Map<string, AgentConfigTeam>): Promise<void> {
    this.ensureLocations(teams);
    await this.upsertIndex(this.executor, activeTeam);
  }

  async removeTeam(teamName: string): Promise<void> {
    await this.executor.query(
      "DELETE FROM agent_teams WHERE tenant_id=$1 AND team_name=$2",
      [this.tenantId, teamName],
    );
    this.locationByName.delete(teamName);
  }

  async renameTeam(teamName: string, newTeamName: string): Promise<void> {
    if (teamName === newTeamName) return;
    const nextLocation = this.nextLocation(newTeamName);
    await this.executor.transaction(async (tx) => {
      const existing = await tx.query(
        "SELECT document, location FROM agent_teams WHERE tenant_id=$1 AND team_name=$2",
        [this.tenantId, teamName],
      );
      if (!existing.rows[0]) {
        this.locationByName.delete(teamName);
        this.locationByName.set(newTeamName, nextLocation);
        return;
      }
      const document = existing.rows[0].document;
      const location = typeof existing.rows[0].location === "string" && existing.rows[0].location.trim()
        ? String(existing.rows[0].location)
        : nextLocation;
      await tx.query(
        "DELETE FROM agent_teams WHERE tenant_id=$1 AND team_name=$2",
        [this.tenantId, teamName],
      );
      await tx.query(
        `INSERT INTO agent_teams(tenant_id, team_name, document, location)
         VALUES($1,$2,$3::jsonb,$4)
         ON CONFLICT (tenant_id, team_name) DO UPDATE SET
           document=EXCLUDED.document,
           location=EXCLUDED.location,
           updated_at=CURRENT_TIMESTAMP`,
        [this.tenantId, newTeamName, JSON.stringify(document), location],
      );
      this.locationByName.delete(teamName);
      this.locationByName.set(newTeamName, location);
    });
  }

  async getTeamLocation(teamName: string): Promise<string | null> {
    return this.locationByName.get(teamName) ?? syntheticTeamLocation(teamName);
  }

  private ensureLocations(teams: Map<string, AgentConfigTeam>): void {
    for (const teamName of teams.keys()) {
      if (!this.locationByName.has(teamName)) {
        this.locationByName.set(teamName, this.nextLocation(teamName));
      }
    }
  }

  private nextLocation(teamName: string): string {
    const base = syntheticTeamLocation(teamName);
    if (!new Set(this.locationByName.values()).has(base)) {
      return base;
    }
    return `${base}-${Date.now()}`;
  }

  private async upsertIndex(executor: PostgresMemoryExecutor, activeTeam: string): Promise<void> {
    await executor.query(
      `INSERT INTO agent_team_index(tenant_id, active_team)
       VALUES($1,$2)
       ON CONFLICT (tenant_id) DO UPDATE SET
         active_team=EXCLUDED.active_team,
         updated_at=CURRENT_TIMESTAMP`,
      [this.tenantId, activeTeam],
    );
  }

  private async upsertTeam(
    executor: PostgresMemoryExecutor,
    teamName: string,
    configs: AgentConfigTeam,
  ): Promise<void> {
    const location = this.locationByName.get(teamName) ?? syntheticTeamLocation(teamName);
    const document = {
      agents: configsToRecord(configs),
      metadata: {
        updated_at: new Date().toISOString(),
        version: AGENT_CONFIG_SCHEMA_VERSION,
      },
    };
    await executor.query(
      `INSERT INTO agent_teams(tenant_id, team_name, document, location)
       VALUES($1,$2,$3::jsonb,$4)
       ON CONFLICT (tenant_id, team_name) DO UPDATE SET
         document=EXCLUDED.document,
         location=EXCLUDED.location,
         updated_at=CURRENT_TIMESTAMP`,
      [this.tenantId, teamName, JSON.stringify(document), location],
    );
  }
}

export function syntheticTeamLocation(teamName: string): string {
  return `postgres://agent_teams/${encodeURIComponent(teamName)}`;
}

function parseTeamDocument(raw: unknown): AgentConfigTeam | null {
  const document = typeof raw === "string"
    ? safeJsonParse(raw)
    : raw;
  if (!isRecord(document) || !isRecord(document.agents)) {
    return null;
  }
  const configs = new Map<string, AgentConfig>();
  for (const [agentName, value] of Object.entries(document.agents)) {
    if (!isRecord(value)) continue;
    const parsed = AgentConfigSchema.safeParse({
      ...value,
      agent_name: typeof value.agent_name === "string" && value.agent_name.trim()
        ? value.agent_name
        : agentName,
    });
    if (!parsed.success) continue;
    const config = normalizeConfig(parsed.data);
    configs.set(config.agent_name, config);
  }
  return configs.size > 0 ? configs : null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
