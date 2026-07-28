import type {
  ChildAgentInfo,
  CreateChildAgentInput,
  FindChildAgentByCreatorInput,
  ListChildAgentsInput,
  UpdateChildAgentLastRunInput,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const columns = `
  child_agent_id, session_id, agent_name, thread_key, status,
  created_seq, created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
  last_run_id, metadata, created_at, updated_at
`;

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function childAgent(row: Record<string, unknown>): ChildAgentInfo {
  let metadata: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { metadata = {}; }
  } else if (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) {
    metadata = row.metadata as Record<string, unknown>;
  }
  return {
    child_agent_id: String(row.child_agent_id),
    session_id: String(row.session_id),
    agent_name: String(row.agent_name),
    thread_key: String(row.thread_key),
    status: String(row.status),
    created_seq: row.created_seq == null ? null : Number(row.created_seq),
    created_by_run_id: row.created_by_run_id == null ? null : String(row.created_by_run_id),
    created_by_call_id: row.created_by_call_id == null ? null : String(row.created_by_call_id),
    parent_run_id: row.parent_run_id == null ? null : String(row.parent_run_id),
    parent_call_id: row.parent_call_id == null ? null : String(row.parent_call_id),
    last_run_id: row.last_run_id == null ? null : String(row.last_run_id),
    metadata,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Tenant-scoped PostgreSQL child-agent aggregate. */
export class PostgresChildAgentRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async assertTenantSession(tenantId: string, sessionId: string): Promise<void> {
    const result = await this.executor.query(
      "SELECT 1 FROM conversation_sessions WHERE tenant_id=$1 AND session_id=$2",
      [tenantId, sessionId],
    );
    if (!result.rows[0]) throw new Error(`session does not belong to tenant: ${sessionId}`);
  }

  async createChildAgent(tenantId: string, input: CreateChildAgentInput): Promise<ChildAgentInfo> {
    const threadKey = input.threadKey?.trim() || `child:${input.childAgentId}`;
    const status = input.status ?? "active";
    const inserted = await this.executor.query(
      `INSERT INTO saas_child_agents
        (tenant_id, child_agent_id, session_id, agent_name, thread_key, status,
         created_seq, created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
         last_run_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       RETURNING ${columns}`,
      [
        tenantId,
        input.childAgentId,
        input.sessionId,
        input.agentName,
        threadKey,
        status,
        input.createdSeq ?? null,
        input.createdByRunId ?? null,
        input.createdByCallId ?? null,
        input.parentRunId ?? null,
        input.parentCallId ?? null,
        input.lastRunId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!inserted.rows[0]) throw new Error(`child agent insert failed: ${input.childAgentId}`);
    return childAgent(inserted.rows[0]);
  }

  async listChildAgents(
    tenantId: string,
    input: ListChildAgentsInput,
  ): Promise<{ items: ChildAgentInfo[]; total: number }> {
    const agentName = input.agentName ?? null;
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 100)));
    const [total, rows] = await Promise.all([
      this.executor.query<{ cnt: string }>(
        "SELECT COUNT(*)::text AS cnt FROM saas_child_agents WHERE tenant_id=$1 AND session_id=$2 AND ($3::text IS NULL OR agent_name=$3)",
        [tenantId, input.sessionId, agentName],
      ),
      this.executor.query(
        `SELECT ${columns} FROM saas_child_agents
         WHERE tenant_id=$1 AND session_id=$2 AND ($3::text IS NULL OR agent_name=$3)
         ORDER BY created_at DESC LIMIT $4`,
        [tenantId, input.sessionId, agentName, limit],
      ),
    ]);
    return { items: rows.rows.map(childAgent), total: Number(total.rows[0]?.cnt ?? 0) };
  }

  async getChildAgent(tenantId: string, sessionId: string, childAgentId: string): Promise<ChildAgentInfo | null> {
    const result = await this.executor.query(
      `SELECT ${columns} FROM saas_child_agents WHERE tenant_id=$1 AND session_id=$2 AND child_agent_id=$3`,
      [tenantId, sessionId, childAgentId],
    );
    return result.rows[0] ? childAgent(result.rows[0]) : null;
  }

  async findChildAgentByCreator(
    tenantId: string,
    input: FindChildAgentByCreatorInput,
  ): Promise<ChildAgentInfo | null> {
    const result = await this.executor.query(
      `SELECT ${columns} FROM saas_child_agents
       WHERE tenant_id=$1 AND session_id=$2 AND created_by_run_id=$3 AND created_by_call_id=$4
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, input.sessionId, input.createdByRunId, input.createdByCallId],
    );
    return result.rows[0] ? childAgent(result.rows[0]) : null;
  }

  async updateChildAgentLastRun(
    tenantId: string,
    input: UpdateChildAgentLastRunInput,
  ): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE saas_child_agents SET last_run_id=$1, updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$2 AND session_id=$3 AND child_agent_id=$4`,
      [input.lastRunId, tenantId, input.sessionId, input.childAgentId],
    );
    return Number(result.rowCount ?? 0) > 0;
  }
}
