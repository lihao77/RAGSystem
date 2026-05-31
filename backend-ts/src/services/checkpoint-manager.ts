import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export interface CheckpointManagerOptions {
  dbPath: string;
}

export interface CheckpointInfo {
  checkpoint_id: string;
  session_id: string;
  agent_name: string;
  round: number;
  messages: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CheckpointListItem {
  checkpoint_id: string;
  session_id: string;
  agent_name: string;
  round: number;
  created_at: string;
}

interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  agent_name: string;
  round: number;
  messages: string;
  metadata: string | null;
  created_at: string;
}

interface CheckpointListRow {
  checkpoint_id: string;
  session_id: string;
  agent_name: string;
  round: number;
  created_at: string;
}

export class CheckpointManager {
  private readonly db: import("node:sqlite").DatabaseSync;

  constructor(options: CheckpointManagerOptions) {
    if (options.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath);
    this.initDatabase();
  }

  close(): void {
    this.db.close();
  }

  saveCheckpoint(input: {
    sessionId: string;
    agentName: string;
    round: number;
    messages: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
  }): string {
    const checkpointId = `${input.sessionId}_${input.agentName}_r${input.round}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO checkpoints
          (checkpoint_id, session_id, agent_name, round, messages, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        checkpointId,
        input.sessionId,
        input.agentName,
        input.round,
        JSON.stringify(input.messages),
        JSON.stringify(input.metadata ?? {}),
        createdAt,
      );
    return checkpointId;
  }

  loadCheckpoint(checkpointId: string): CheckpointInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT checkpoint_id, session_id, agent_name, round, messages, metadata, created_at
          FROM checkpoints
          WHERE checkpoint_id=?
        `,
      )
      .get(checkpointId) as CheckpointRow | undefined;
    return row ? rowToCheckpoint(row) : null;
  }

  getLatestCheckpoint(sessionId: string, agentName?: string | null): CheckpointInfo | null {
    const row = agentName
      ? (this.db
          .prepare(
            `
              SELECT checkpoint_id, session_id, agent_name, round, messages, metadata, created_at
              FROM checkpoints
              WHERE session_id=? AND agent_name=?
              ORDER BY round DESC
              LIMIT 1
            `,
          )
          .get(sessionId, agentName) as CheckpointRow | undefined)
      : (this.db
          .prepare(
            `
              SELECT checkpoint_id, session_id, agent_name, round, messages, metadata, created_at
              FROM checkpoints
              WHERE session_id=?
              ORDER BY round DESC
              LIMIT 1
            `,
          )
          .get(sessionId) as CheckpointRow | undefined);
    return row ? rowToCheckpoint(row) : null;
  }

  listCheckpoints(input: { sessionId: string; agentName?: string | null; limit?: number }): CheckpointListItem[] {
    const limit = input.limit ?? 10;
    const rows = input.agentName
      ? (this.db
          .prepare(
            `
              SELECT checkpoint_id, session_id, agent_name, round, created_at
              FROM checkpoints
              WHERE session_id=? AND agent_name=?
              ORDER BY round DESC
              LIMIT ?
            `,
          )
          .all(input.sessionId, input.agentName, limit) as unknown as CheckpointListRow[])
      : (this.db
          .prepare(
            `
              SELECT checkpoint_id, session_id, agent_name, round, created_at
              FROM checkpoints
              WHERE session_id=?
              ORDER BY round DESC
              LIMIT ?
            `,
          )
          .all(input.sessionId, limit) as unknown as CheckpointListRow[]);
    return rows.map(rowToCheckpointListItem);
  }

  deleteCheckpoint(checkpointId: string): boolean {
    const result = this.db.prepare("DELETE FROM checkpoints WHERE checkpoint_id=?").run(checkpointId);
    return Number(result.changes) > 0;
  }

  deleteSessionCheckpoints(sessionId: string): number {
    const result = this.db.prepare("DELETE FROM checkpoints WHERE session_id=?").run(sessionId);
    return Number(result.changes);
  }

  cleanupOldCheckpoints(days = 7): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("DELETE FROM checkpoints WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        messages TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_id ON checkpoints(session_id);
      CREATE INDEX IF NOT EXISTS idx_created_at ON checkpoints(created_at);
    `);
  }
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function rowToCheckpoint(row: CheckpointRow): CheckpointInfo {
  return {
    checkpoint_id: row.checkpoint_id,
    session_id: row.session_id,
    agent_name: row.agent_name,
    round: row.round,
    messages: parseJsonArray(row.messages),
    metadata: parseJsonObject(row.metadata),
    created_at: row.created_at,
  };
}

function rowToCheckpointListItem(row: CheckpointListRow): CheckpointListItem {
  return {
    checkpoint_id: row.checkpoint_id,
    session_id: row.session_id,
    agent_name: row.agent_name,
    round: row.round,
    created_at: row.created_at,
  };
}

function parseJsonObject(rawValue: string | null | undefined): Record<string, unknown> {
  if (!rawValue) {
    return {};
  }
  const parsed = JSON.parse(rawValue) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseJsonArray(rawValue: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(rawValue) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is Record<string, unknown> => {
    return item !== null && typeof item === "object" && !Array.isArray(item);
  });
}
