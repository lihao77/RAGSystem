import { runInTransaction } from "./shared/transaction.js";
import { BASELINE_SCHEMA_SQL } from "./schema.js";
import { MessageContentPartSchema, type MessageContentPart } from "@ragsystem/agent-protocol";

export interface MigrationDatabase {
  exec: import("node:sqlite").DatabaseSync["exec"];
  prepare: import("node:sqlite").DatabaseSync["prepare"];
}

export const LATEST_SCHEMA_VERSION = 6;

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
  if (current === 1 || current === 2 || current === 3 || current === 4 || current === 5) {
    assertVersionOneSchema(db);
    runInTransaction(db, () => {
      if (current === 1) db.exec("ALTER TABLE runs ADD COLUMN terminal_reason TEXT");
      if (current <= 2) db.exec("ALTER TABLE workspaces ADD COLUMN removed_at TIMESTAMP");
      if (current <= 4) {
        db.exec("ALTER TABLE messages ADD COLUMN content_parts TEXT NOT NULL DEFAULT '[]'");
        migrateCanonicalMessageContent(db);
      }
      migrateCommandContent(db);
      db.exec(`
        DELETE FROM workspaces
        WHERE removed_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE sessions.tenant_id=workspaces.tenant_id
              AND sessions.workspace_id=workspaces.workspace_id
          )
      `);
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
  const runColumns = db.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "terminal_reason")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as unknown as Array<{ name: string }>;
  if (!workspaceColumns.some((column) => column.name === "removed_at")) {
    throw new Error("Conversation database schema is obsolete; delete the development database and restart");
  }
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as unknown as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "content_parts")) {
    throw new Error("Conversation database is missing canonical message content_parts");
  }
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
