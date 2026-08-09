import { runInTransaction } from "./shared/transaction.js";
import { AGENT_MAILBOX_SCHEMA_SQL, BASELINE_SCHEMA_SQL, RUNS_SCHEMA_SQL } from "./schema.js";
import { MessageContentPartSchema, type MessageContentPart } from "@ragsystem/agent-protocol";

export interface MigrationDatabase {
  exec: import("node:sqlite").DatabaseSync["exec"];
  prepare: import("node:sqlite").DatabaseSync["prepare"];
}

export const LATEST_SCHEMA_VERSION = 12;

export function assertVersionsContiguous(migrations: readonly { version: number; name: string }[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(`migration version gap: expected ${expected}, received ${migration.version} (${migration.name})`);
    }
  });
}

function getUserVersion(db: MigrationDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Applies explicit schema versions only; historical session data is never repaired here. */
export function runMigrations(db: MigrationDatabase): void {
  const current = getUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Conversation database schema v${current} is obsolete; delete the development database and restart`);
  }
  if (current === LATEST_SCHEMA_VERSION) {
    assertCurrentSchema(db);
    return;
  }
  if (current >= 1 && current <= 11) {
    assertVersionOneSchema(db);
    runInTransaction(db, () => {
      if (current === 1) db.exec("ALTER TABLE runs ADD COLUMN terminal_reason TEXT");
      if (current <= 2) db.exec("ALTER TABLE workspaces ADD COLUMN removed_at TIMESTAMP");
      if (current <= 4) {
        db.exec("ALTER TABLE messages ADD COLUMN content_parts TEXT NOT NULL DEFAULT '[]'");
        migrateCanonicalMessageContent(db);
      }
      migrateCommandContent(db);
      if (current <= 7) migrateRunLifecycleIdentity(db);
      if (current <= 8) {
        db.exec(`
          DELETE FROM workspaces
          WHERE removed_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM sessions
              WHERE sessions.tenant_id=workspaces.tenant_id
                AND sessions.workspace_id=workspaces.workspace_id
            )
        `);
        db.exec(AGENT_MAILBOX_SCHEMA_SQL);
      }
      migrateAgentMailboxTenantKey(db);
      if (current <= 10) ensureChildParticipantLineage(db);
      if (current <= 11) {
        const sessions = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count?: number } | undefined;
        if (Number(sessions?.count ?? 0) > 0) {
          throw new Error("Conversation database contains sessions without immutable Team snapshots; delete the development database and restart");
        }
        db.exec("ALTER TABLE sessions ADD COLUMN team_snapshot TEXT NOT NULL");
      }
      db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    });
    assertCurrentSchema(db);
    return;
  }
  const existing = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name LIMIT 1
  `).get() as { name: string } | undefined;
  if (existing) {
    throw new Error(`Conversation database contains obsolete table '${existing.name}'; delete the development database and restart`);
  }
  runInTransaction(db, () => {
    db.exec(BASELINE_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
  });
}

function ensureChildParticipantLineage(db: MigrationDatabase): void {
  const columns = db.prepare("PRAGMA table_info(child_agents)").all() as unknown as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "parent_participant_id")) {
    db.exec("ALTER TABLE child_agents ADD COLUMN parent_participant_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_child_agents_parent ON child_agents(session_id, parent_participant_id, created_at DESC)");
}

function migrateAgentMailboxTenantKey(db: MigrationDatabase): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_mailbox'").get() as { name?: string } | undefined;
  if (!table?.name) {
    db.exec(AGENT_MAILBOX_SCHEMA_SQL);
    return;
  }
  for (const index of [
    "idx_agent_mailbox_target_run",
    "idx_agent_mailbox_target_thread",
    "idx_agent_mailbox_claim_expiry",
    "idx_agent_mailbox_correlation",
  ]) {
    db.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  db.exec("ALTER TABLE agent_mailbox RENAME TO agent_mailbox_pre_v10");
  db.exec(AGENT_MAILBOX_SCHEMA_SQL);
  db.exec(`
    INSERT INTO agent_mailbox (
      seq, message_id, tenant_id, session_id, source_run_id, source_agent_call_id,
      target_run_id, target_agent_call_id, target_thread_key, target_child_agent_id,
      kind, correlation_id, reply_to_message_id, content_parts, metadata, status,
      attempt_count, claim_id, claimed_by, claim_expires_at, available_at, expires_at,
      last_error, created_at, updated_at, acked_at
    )
    SELECT
      seq, message_id, tenant_id, session_id, source_run_id, source_agent_call_id,
      target_run_id, target_agent_call_id, target_thread_key, target_child_agent_id,
      kind, correlation_id, reply_to_message_id, content_parts, metadata, status,
      attempt_count, claim_id, claimed_by, claim_expires_at, available_at, expires_at,
      last_error, created_at, updated_at, acked_at
    FROM agent_mailbox_pre_v10
  `);
  db.exec("DROP TABLE agent_mailbox_pre_v10");
}

function migrateCommandContent(db: MigrationDatabase): void {
  const rows = db.prepare(`
    SELECT seq,id,session_id,content,content_parts,metadata,thread_key
    FROM messages ORDER BY seq
  `).all() as unknown as Array<{
    seq: number;
    id: string;
    session_id: string;
    content: string;
    content_parts: string;
    metadata: string | null;
    thread_key: string | null;
  }>;
  const update = db.prepare("UPDATE messages SET content_parts=?, metadata=? WHERE seq=?");
  const latestInvocationByThread = new Map<string, string>();
  for (const row of rows) {
    const metadata = parseObject(row.metadata);
    const messageType = metadata.msg_type;
    const threadKey = `${row.session_id}\0${row.thread_key ?? "root"}`;
    if (messageType === "command") {
      const invocationId = `cmd_${row.id}`;
      const name = stringValue(metadata.command) ?? commandName(row.content);
      const args = commandArgs(row.content);
      const expanded = stringValue(metadata.expanded_task);
      const commandPart: MessageContentPart = {
        type: "command_ref",
        invocation_id: invocationId,
        name,
        args,
        raw_text: row.content || `/${name}`,
        resolution: metadata.command_mode === "prompt" && expanded
          ? { kind: "prompt", agent_text: expanded, snapshot_id: `migration:${row.id}` }
          : { kind: "system" },
      };
      const existing = parseContentParts(row.content_parts);
      let removedSourceText = false;
      const retained = existing.filter((part) => {
        if (!removedSourceText && part.type === "text" && part.text === row.content) {
          removedSourceText = true;
          return false;
        }
        return true;
      });
      latestInvocationByThread.set(threadKey, invocationId);
      cleanCommandMetadata(metadata);
      update.run(JSON.stringify([commandPart, ...retained]), JSON.stringify(metadata), row.seq);
      continue;
    }
    if (messageType === "command_result") {
      const name = stringValue(metadata.command) ?? "unknown";
      const error = stringValue(metadata.error);
      const resultPart: MessageContentPart = {
        type: "command_result",
        invocation_id: latestInvocationByThread.get(threadKey) ?? `cmd_result_${row.id}`,
        name,
        success: metadata.success !== false,
        text: row.content,
        ...(error ? { error } : {}),
      };
      cleanCommandMetadata(metadata);
      update.run(JSON.stringify([resultPart]), JSON.stringify(metadata), row.seq);
    }
  }
}

function parseContentParts(value: string): MessageContentPart[] {
  try {
    const parsed = MessageContentPartSchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function cleanCommandMetadata(metadata: Record<string, unknown>): void {
  delete metadata.msg_type;
  delete metadata.command;
  delete metadata.command_mode;
  delete metadata.expanded_task;
  delete metadata.success;
  delete metadata.error;
}

function commandName(content: string): string {
  const match = /^\s*\/([^\s/]+)/.exec(content);
  return match?.[1]?.toLowerCase() || "unknown";
}

function commandArgs(content: string): string {
  return content.trim().replace(/^\/[^\s/]+\s*/, "").trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertVersionOneSchema(db: MigrationDatabase): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("owner_user_id") || !names.has("origin_type") || !names.has("workspace_id")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const goalColumns = db.prepare("PRAGMA table_info(workflow_goals)").all() as unknown as Array<{ name: string }>;
  if (!goalColumns.some((column) => column.name === "continuation_reason")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
}

function assertCurrentSchema(db: MigrationDatabase): void {
  assertVersionOneSchema(db);
  const runColumns = db.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{ name: string; notnull: number }>;
  if (!runColumns.some((column) => column.name === "terminal_reason")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  for (const name of ["agent_call_id", "lineage_parent_call_id", "agent_display_name", "lease_root_run_id"]) {
    if (!runColumns.some((column) => column.name === name)) {
      throw new Error(`Conversation database is missing run lifecycle column ${name}`);
    }
  }
  for (const name of ["agent_call_id", "agent_display_name", "lease_root_run_id"]) {
    if (runColumns.find((column) => column.name === name)?.notnull !== 1) {
      throw new Error(`Conversation database run lifecycle column ${name} must be NOT NULL`);
    }
  }
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as unknown as Array<{ name: string }>;
  if (!workspaceColumns.some((column) => column.name === "removed_at")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as unknown as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "content_parts")) {
    throw new Error("Conversation database is missing canonical message content_parts");
  }
  const mailboxColumns = db.prepare("PRAGMA table_info(agent_mailbox)").all() as unknown as Array<{ name: string }>;
  for (const name of ["message_id", "session_id", "target_thread_key", "kind", "status", "content_parts", "metadata"]) {
    if (!mailboxColumns.some((column) => column.name === name)) {
      throw new Error(`Conversation database is missing Agent mailbox column ${name}`);
    }
  }
  const childAgentColumns = db.prepare("PRAGMA table_info(child_agents)").all() as unknown as Array<{ name: string }>;
  if (!childAgentColumns.some((column) => column.name === "parent_participant_id")) {
    throw new Error("Conversation database is missing child participant lineage column");
  }
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "team_snapshot")) {
    throw new Error("Conversation database is missing immutable Session Team snapshot");
  }
}

function migrateRunLifecycleIdentity(db: MigrationDatabase): void {
  const columns = db.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const agentCallId = names.has("agent_call_id")
    ? "COALESCE(NULLIF(legacy.agent_call_id, ''), legacy.run_id)"
    : "legacy.run_id";
  const lineageParentCallId = names.has("lineage_parent_call_id") ? "legacy.lineage_parent_call_id" : "NULL";
  const agentDisplayName = names.has("agent_display_name")
    ? "COALESCE(NULLIF(legacy.agent_display_name, ''), NULLIF(legacy.agent_name, ''), 'unknown')"
    : "COALESCE(NULLIF(legacy.agent_name, ''), 'unknown')";
  const leaseRootRunId = names.has("lease_root_run_id")
    ? "COALESCE(NULLIF(legacy.lease_root_run_id, ''), roots.lease_root_run_id, legacy.run_id)"
    : "COALESCE(roots.lease_root_run_id, legacy.run_id)";
  db.exec("ALTER TABLE runs RENAME TO runs_pre_v7");
  db.exec(`
    DROP INDEX IF EXISTS runs_session_agent_call_idx;
    DROP INDEX IF EXISTS runs_lease_root_status_idx;
    DROP INDEX IF EXISTS idx_runs_session;
    DROP INDEX IF EXISTS idx_runs_session_thread_created;
  `);
  db.exec(RUNS_SCHEMA_SQL);
  db.exec(`
    WITH RECURSIVE run_roots(run_id, lease_root_run_id) AS (
      SELECT run_id, run_id FROM runs_pre_v7 WHERE parent_run_id IS NULL
      UNION ALL
      SELECT child.run_id, parent.lease_root_run_id
      FROM runs_pre_v7 AS child
      JOIN run_roots AS parent ON child.parent_run_id = parent.run_id
    )
    INSERT INTO runs (
      run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
      request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
      agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
      final_message_id, child_agent_id, created_at, updated_at
    )
    SELECT
      legacy.run_id, legacy.session_id, legacy.tenant_id, legacy.entrypoint, legacy.status,
      legacy.task_summary, legacy.terminal_reason, legacy.request_id, legacy.user_id,
      legacy.agent_name, ${agentCallId}, ${lineageParentCallId}, ${agentDisplayName},
      ${leaseRootRunId}, legacy.thread_key, legacy.parent_run_id, legacy.parent_call_id,
      legacy.final_message_id, legacy.child_agent_id, legacy.created_at, legacy.updated_at
    FROM runs_pre_v7 AS legacy
    LEFT JOIN run_roots AS roots ON roots.run_id = legacy.run_id;
    DROP TABLE runs_pre_v7;
    CREATE UNIQUE INDEX IF NOT EXISTS runs_session_agent_call_idx
      ON runs(session_id, agent_call_id);
    CREATE INDEX IF NOT EXISTS runs_lease_root_status_idx
      ON runs(session_id, lease_root_run_id, status);
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_runs_session_thread_created ON runs(session_id, thread_key, created_at);
  `);
}

function migrateCanonicalMessageContent(db: MigrationDatabase): void {
  const rows = db.prepare("SELECT seq, content, metadata FROM messages ORDER BY seq").all() as unknown as Array<{
    seq: number;
    content: string;
    metadata: string | null;
  }>;
  const update = db.prepare("UPDATE messages SET content_parts=?, metadata=? WHERE seq=?");
  for (const row of rows) {
    const metadata = parseObject(row.metadata);
    const extensions = Array.isArray(metadata.extensions) ? metadata.extensions : [];
    const rich = extensions.find((extension) => isRecord(extension) && extension.kind === "rich_content");
    let parts: MessageContentPart[] | null = null;
    if (isRecord(rich) && isRecord(rich.data)) {
      const parsed = MessageContentPartSchema.array().safeParse(rich.data.parts);
      if (parsed.success) parts = parsed.data;
    }
    if (!parts) {
      parts = row.content ? [{ type: "text", text: row.content }] : [];
      const attachmentExtension = extensions.find((extension) => isRecord(extension) && extension.kind === "attachments");
      if (isRecord(attachmentExtension) && isRecord(attachmentExtension.data) && Array.isArray(attachmentExtension.data.items)) {
        for (const item of attachmentExtension.data.items) {
          if (!isRecord(item)) continue;
          const parsed = MessageContentPartSchema.safeParse({
            type: "attachment_ref",
            file_id: item.file_id,
            original_name: item.original_name,
            stored_name: item.stored_name,
            mime: item.mime,
            size: item.size,
            kind: item.kind,
            presentation: item.kind === "image" ? "inline" : "attachment",
            ...(typeof item.file_path === "string" && item.file_path ? { file_path: item.file_path } : {}),
            ...(item.file_path_space === "uploads" || item.file_path_space === "absolute"
              ? { file_path_space: item.file_path_space }
              : {}),
          });
          if (parsed.success) parts.push(parsed.data);
        }
      }
    }
    const retained = extensions.filter((extension) => !isRecord(extension)
      || (extension.kind !== "rich_content" && extension.kind !== "attachments"));
    if (retained.length > 0) metadata.extensions = retained;
    else delete metadata.extensions;
    update.run(JSON.stringify(parts), JSON.stringify(metadata), row.seq);
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
