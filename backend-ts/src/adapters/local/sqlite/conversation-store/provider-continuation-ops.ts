import { parseProviderContinuationState } from "@ragsystem/agent-llm";
import type {
  ProviderContinuationRecord,
  PutProviderContinuationInput,
} from "../../../../contracts/conversation-store/index.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";

interface ProviderContinuationRow {
  message_id: string;
  session_id: string;
  thread_key: string;
  provider_type: string;
  tool_call_ids: string;
  state: string;
  created_at: string;
}

export class ProviderContinuationOps {
  constructor(private readonly db: ConversationDb) {}

  putProviderContinuation(input: PutProviderContinuationInput): ProviderContinuationRecord {
    return runInTransaction(this.db, () => this.putProviderContinuationInTransaction(input));
  }

  putProviderContinuationInTransaction(input: PutProviderContinuationInput): ProviderContinuationRecord {
    this.db.prepare(`
      INSERT INTO provider_continuations
        (message_id, session_id, thread_key, provider_type, tool_call_ids, state)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        provider_type=excluded.provider_type,
        tool_call_ids=excluded.tool_call_ids,
        state=excluded.state,
        created_at=CURRENT_TIMESTAMP
    `).run(
      input.messageId,
      input.sessionId,
      input.threadKey,
      input.providerType,
      JSON.stringify(input.toolCallIds),
      JSON.stringify(input.state),
    );
    const record = this.getProviderContinuation(input.sessionId, input.messageId);
    if (!record) throw new Error(`Provider continuation insert failed: ${input.messageId}`);
    return record;
  }

  getProviderContinuation(sessionId: string, messageId: string): ProviderContinuationRecord | null {
    const row = this.db.prepare(`
      SELECT message_id, session_id, thread_key, provider_type, tool_call_ids, state, created_at
      FROM provider_continuations
      WHERE session_id=? AND message_id=?
    `).get(sessionId, messageId) as ProviderContinuationRow | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  deleteProviderContinuations(sessionId: string, threadKey: string): number {
    return Number(this.db.prepare(
      "DELETE FROM provider_continuations WHERE session_id=? AND thread_key=?",
    ).run(sessionId, threadKey).changes);
  }
}

function mapRow(row: ProviderContinuationRow): ProviderContinuationRecord | null {
  try {
    const state = parseProviderContinuationState(JSON.parse(row.state) as unknown);
    const toolCallIds = JSON.parse(row.tool_call_ids) as unknown;
    if (!state || !Array.isArray(toolCallIds) || !toolCallIds.every((item) => typeof item === "string")) return null;
    return {
      message_id: row.message_id,
      session_id: row.session_id,
      thread_key: row.thread_key,
      provider_type: row.provider_type,
      tool_call_ids: toolCallIds,
      state,
      created_at: row.created_at,
    };
  } catch {
    return null;
  }
}
