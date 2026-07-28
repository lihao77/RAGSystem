import { parseProviderContinuationState } from "@ragsystem/agent-llm";

import type {
  ProviderContinuationRecord,
  PutProviderContinuationInput,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresExecutor } from "./postgres-executor.js";

export interface AsyncProviderContinuationRepository {
  putProviderContinuation(tenantId: TenantId, input: PutProviderContinuationInput): Promise<ProviderContinuationRecord>;
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<ProviderContinuationRecord | null>;
  deleteProviderContinuations(tenantId: TenantId, sessionId: string, threadKey: string): Promise<number>;
}

const columns = "message_id, session_id, thread_key, provider_type, tool_call_ids, state, created_at";

export class PostgresProviderContinuationRepository implements AsyncProviderContinuationRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async putProviderContinuation(
    tenantId: TenantId,
    input: PutProviderContinuationInput,
  ): Promise<ProviderContinuationRecord> {
    const result = await this.executor.query(
      `INSERT INTO provider_continuations
        (tenant_id, message_id, session_id, thread_key, provider_type, tool_call_ids, state)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
       ON CONFLICT (tenant_id, message_id) DO UPDATE SET
         provider_type=EXCLUDED.provider_type,
         tool_call_ids=EXCLUDED.tool_call_ids,
         state=EXCLUDED.state,
         created_at=CURRENT_TIMESTAMP
       RETURNING ${columns}`,
      [
        tenantId,
        input.messageId,
        input.sessionId,
        input.threadKey,
        input.providerType,
        JSON.stringify(input.toolCallIds),
        JSON.stringify(input.state),
      ],
    );
    const record = result.rows[0] ? mapRow(result.rows[0]) : null;
    if (!record) throw new Error(`Provider continuation insert failed: ${input.messageId}`);
    return record;
  }

  async getProviderContinuation(
    tenantId: TenantId,
    sessionId: string,
    messageId: string,
  ): Promise<ProviderContinuationRecord | null> {
    const result = await this.executor.query(
      `SELECT ${columns} FROM provider_continuations
       WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3`,
      [tenantId, sessionId, messageId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async deleteProviderContinuations(
    tenantId: TenantId,
    sessionId: string,
    threadKey: string,
  ): Promise<number> {
    const result = await this.executor.query(
      "DELETE FROM provider_continuations WHERE tenant_id=$1 AND session_id=$2 AND thread_key=$3",
      [tenantId, sessionId, threadKey],
    );
    return Number(result.rowCount ?? 0);
  }
}

function mapRow(row: Record<string, unknown>): ProviderContinuationRecord | null {
  try {
    const state = parseProviderContinuationState(parseJson(row.state));
    const toolCallIds = parseJson(row.tool_call_ids);
    if (!state || !Array.isArray(toolCallIds) || !toolCallIds.every((item) => typeof item === "string")) return null;
    return {
      message_id: String(row.message_id),
      session_id: String(row.session_id),
      thread_key: String(row.thread_key),
      provider_type: String(row.provider_type),
      tool_call_ids: toolCallIds,
      state,
      created_at: new Date(String(row.created_at)).toISOString(),
    };
  } catch {
    return null;
  }
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}
