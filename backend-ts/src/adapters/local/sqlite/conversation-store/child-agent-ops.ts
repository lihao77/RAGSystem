import type { ConversationDb } from "./shared/db.js";
import { stringifyJson } from "./helpers.js";
import { rowToChildAgent } from "./mappers.js";
import type {
  ChildAgentInfo,
  CreateChildAgentInput,
  FindChildAgentByCreatorInput,
  IChildAgentStore,
  ListChildAgentsInput,
  UpdateChildAgentLastRunInput,
} from "../../../../contracts/conversation-store/index.js";
import type { ChildAgentRow } from "./types.js";

const CHILD_AGENT_SELECT_COLUMNS = `
  child_agent_id, session_id, agent_name, thread_key, status,
  created_seq, created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
  last_run_id, metadata, created_at, updated_at
`;

/** child_agents 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class ChildAgentOps implements IChildAgentStore {
  constructor(private readonly db: ConversationDb) {}

  createChildAgent(input: CreateChildAgentInput): ChildAgentInfo {
    const threadKey = input.threadKey?.trim() || `child:${input.childAgentId}`;
    const status = input.status ?? "active";
    const metadata = input.metadata ?? {};
    this.db
      .prepare(
        `
          INSERT INTO child_agents (
            child_agent_id, session_id, agent_name, thread_key, status,
            created_seq, created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
            last_run_id, metadata
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
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
        stringifyJson(metadata),
      );
    const row = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND child_agent_id=?
        `,
      )
      .get(input.sessionId, input.childAgentId) as ChildAgentRow | undefined;
    if (!row) {
      throw new Error(`Child agent insert failed: ${input.childAgentId}`);
    }
    return rowToChildAgent(row);
  }

  listChildAgents(input: ListChildAgentsInput): { items: ChildAgentInfo[]; total: number } {
    const agentName = input.agentName ?? null;
    const limit = input.limit ?? 100;
    const totalRow = this.db
      .prepare(
        "SELECT COUNT(1) AS cnt FROM child_agents WHERE session_id=? AND (? IS NULL OR agent_name=?)",
      )
      .get(input.sessionId, agentName, agentName) as { cnt: number };
    const rows = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND (? IS NULL OR agent_name=?)
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(input.sessionId, agentName, agentName, limit) as unknown as ChildAgentRow[];
    const items = rows.map(rowToChildAgent);
    return { items, total: totalRow.cnt };
  }

  getChildAgent(sessionId: string, childAgentId: string): ChildAgentInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND child_agent_id=?
        `,
      )
      .get(sessionId, childAgentId) as ChildAgentRow | undefined;
    return row ? rowToChildAgent(row) : null;
  }

  findChildAgentByCreator(input: FindChildAgentByCreatorInput): ChildAgentInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND created_by_run_id=? AND created_by_call_id=?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(input.sessionId, input.createdByRunId, input.createdByCallId) as ChildAgentRow | undefined;
    return row ? rowToChildAgent(row) : null;
  }

  updateChildAgentLastRun(input: UpdateChildAgentLastRunInput): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE child_agents
          SET last_run_id=?, updated_at=CURRENT_TIMESTAMP
          WHERE session_id=? AND child_agent_id=?
        `,
      )
      .run(input.lastRunId, input.sessionId, input.childAgentId);
    return Number(result.changes) > 0;
  }
}
