import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { Pool, type PoolClient } from "pg";

import { Aes256GcmSecretResolver, PostgresSecretEnvelopeRepository } from "./control-secret-resolver.js";
import { runPostgresControlMigrations } from "./control-migrations.js";
import type { SecretResolver } from "../../../contracts/secret-resolver.js";
import { createTenantId, createUserId } from "../../../identity/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface ControlImportOptions {
  sourceDataRoot: string;
  targetPool: Pool;
  masterKey: Uint8Array;
  importId: string;
}

export interface ControlImportResult {
  importId: string;
  sourcePath: string;
  sourceChecksum: string;
  rowCounts: Record<string, number>;
  alreadyImported: boolean;
}

export class ControlImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlImportConflictError";
  }
}

/** Imports one immutable SQLite control snapshot into the PostgreSQL Control v2 schema. */
export async function importControlSnapshot(options: ControlImportOptions): Promise<ControlImportResult> {
  if (!options.importId.trim()) throw new Error("importId is required");
  if (options.masterKey.byteLength !== 32) throw new Error("masterKey must be exactly 32 bytes");
  const sourceRoot = path.resolve(options.sourceDataRoot);
  const nestedPath = path.join(sourceRoot, "system", "control.db");
  const sourcePath = fs.existsSync(nestedPath) ? nestedPath : path.join(sourceRoot, "control.db");
  if (!fs.existsSync(sourcePath)) throw new Error(`control.db not found: ${sourcePath}`);
  const snapshot = readSnapshot(sourcePath);
  const sourceChecksum = sha256(stableStringify(snapshot));
  await runPostgresControlMigrations(options.targetPool);

  const client = await options.targetPool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ source_checksum: string; row_counts: Record<string, number> }>(
      "SELECT source_checksum, row_counts FROM control_import_checkpoints WHERE import_id=$1",
      [options.importId],
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      if (existing.rows[0].source_checksum !== sourceChecksum) {
        throw new ControlImportConflictError(`import_id already exists with a different source checksum: ${options.importId}`);
      }
      return {
        importId: options.importId,
        sourcePath,
        sourceChecksum,
        rowCounts: existing.rows[0].row_counts,
        alreadyImported: true,
      };
    }

    const secretRepository = new PostgresSecretEnvelopeRepository(client);
    const secrets: SecretResolver = new Aes256GcmSecretResolver(secretRepository, options.masterKey);
    try {
      await insertTenants(client, snapshot.tenants);
      await insertUsers(client, snapshot.users.filter((row) => row.type !== "bot"));
      await insertUsers(client, snapshot.users.filter((row) => row.type === "bot"));
      await insertMemberships(client, snapshot.memberships);
      await insertSessions(client, snapshot.user_sessions);
      await insertSettings(client, snapshot.system_settings);
      await insertPlatformAudit(client, snapshot.platform_audit);
      await insertBots(client, snapshot.bot_configs, snapshot.bot_cron_tasks, secrets);
      await insertWidgets(client, snapshot.widget_apps, snapshot.widget_tokens, snapshot.widget_audit);
      const rowCounts = countRows(snapshot);
      await client.query(`
        INSERT INTO control_import_checkpoints(import_id, source_path, source_checksum, row_counts)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [options.importId, sourcePath, sourceChecksum, JSON.stringify(rowCounts)]);
      await client.query("SELECT setval(pg_get_serial_sequence('control_platform_audit', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM control_platform_audit");
      await client.query("SELECT setval(pg_get_serial_sequence('control_widget_audit', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM control_widget_audit");
      await client.query("COMMIT");
      return { importId: options.importId, sourcePath, sourceChecksum, rowCounts, alreadyImported: false };
    } finally {
      await secrets.close();
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUniqueViolation(error)) {
      const checkpoint = await options.targetPool.query<{ source_checksum: string; row_counts: Record<string, number> }>(
        "SELECT source_checksum, row_counts FROM control_import_checkpoints WHERE import_id=$1",
        [options.importId],
      );
      const row = checkpoint.rows[0];
      if (row?.source_checksum === sourceChecksum) {
        return { importId: options.importId, sourcePath, sourceChecksum, rowCounts: row.row_counts, alreadyImported: true };
      }
      throw new ControlImportConflictError(`control import conflicts with existing target data: ${options.importId}`);
    }
    throw error;
  } finally {
    client.release();
  }
}

type Row = Record<string, unknown>;
interface ControlSnapshot {
  tenants: Row[];
  users: Row[];
  memberships: Row[];
  user_sessions: Row[];
  system_settings: Row[];
  platform_audit: Row[];
  bot_configs: Row[];
  bot_cron_tasks: Row[];
  widget_apps: Row[];
  widget_tokens: Row[];
  widget_audit: Row[];
}

function readSnapshot(sourcePath: string): ControlSnapshot {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  db.exec("BEGIN");
  try {
    const snapshot = {
      tenants: readTable(db, "tenants", "created_at, id"),
      users: readTable(db, "users", "created_at, id"),
      memberships: readTable(db, "memberships", "tenant_id, user_id"),
      user_sessions: readTable(db, "user_sessions", "jti"),
      system_settings: readTable(db, "system_settings", "key"),
      platform_audit: readTable(db, "platform_audit", "id"),
      bot_configs: readTable(db, "bot_configs", "bot_id"),
      bot_cron_tasks: readTable(db, "bot_cron_tasks", "bot_id, task_id"),
      widget_apps: readTable(db, "widget_apps", "app_key"),
      widget_tokens: readTable(db, "widget_tokens", "jti"),
      widget_audit: readTable(db, "widget_audit", "id"),
    } satisfies ControlSnapshot;
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function readTable(db: import("node:sqlite").DatabaseSync, table: string, orderBy: string): Row[] {
  const exists = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table) as { present?: number } | undefined;
  if (!exists) return [];
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as unknown as Row[];
}

async function insertTenants(client: PoolClient, rows: Row[]): Promise<void> {
  for (const row of rows) await client.query("INSERT INTO control_tenants(id, display_name, created_at, status) VALUES ($1, $2, $3, $4)", [createTenantId(String(row.id)), row.display_name, row.created_at, row.status ?? "active"]);
}

async function insertUsers(client: PoolClient, rows: Row[]): Promise<void> {
  for (const row of rows) await client.query(`
    INSERT INTO control_users(id, display_name, created_at, username, password_hash, platform_role, status, type, owner_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [createUserId(String(row.id)), row.display_name, row.created_at, row.username ?? null, row.password_hash ?? null,
    row.platform_role ?? null, row.status ?? "active", row.type ?? "human", row.owner_id ?? null]);
}

async function insertMemberships(client: PoolClient, rows: Row[]): Promise<void> {
  for (const row of rows) await client.query("INSERT INTO control_memberships(user_id, tenant_id, role) VALUES ($1, $2, $3)", [row.user_id, row.tenant_id, row.role]);
}

async function insertSessions(client: PoolClient, rows: Row[]): Promise<void> {
  for (const row of rows) await client.query("INSERT INTO control_user_sessions(jti, user_id, tenant_id, issued_at, expires_at, revoked) VALUES ($1, $2, $3, $4, $5, $6)", [row.jti, row.user_id, row.tenant_id, row.issued_at, row.expires_at, Boolean(row.revoked)]);
}

async function insertSettings(client: PoolClient, rows: Row[]): Promise<void> {
  for (const row of rows) await client.query("INSERT INTO control_system_settings(key, value, updated_at) VALUES ($1, $2, $3)", [row.key, row.value, row.updated_at]);
}

async function insertPlatformAudit(client: PoolClient, rows: Row[]): Promise<void> {
  for (const row of rows) await client.query("INSERT INTO control_platform_audit(id, actor_user_id, action, target_tenant_id, target_resource, detail_json, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)", [row.id, row.actor_user_id, row.action, row.target_tenant_id ?? null, row.target_resource, jsonOrNull(row.detail_json), row.created_at]);
}

async function insertBots(client: PoolClient, configs: Row[], tasks: Row[], secrets: SecretResolver): Promise<void> {
  for (const row of configs) {
    const botId = createUserId(String(row.bot_id));
    const tenantId = createTenantId(String(row.tenant_id));
    const routeToken = nullableString(row.feishu_route_token);
    await client.query(`
      INSERT INTO control_bot_configs(bot_id, tenant_id, enabled, entry_agent, session_id, default_session_ttl,
        permission_mode, feishu_enabled, feishu_app_id, feishu_receive_mode, route_token_digest,
        feishu_default_chat_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [botId, tenantId, Boolean(row.enabled), row.entry_agent ?? null, row.session_id ?? null, row.default_session_ttl ?? 86400,
      row.permission_mode ?? "relaxed", Boolean(row.feishu_enabled), row.feishu_app_id ?? null, row.feishu_receive_mode ?? "webhook",
      routeToken ? digest(routeToken) : null, row.feishu_default_chat_id ?? null, row.created_at, row.updated_at]);
    for (const [field, value] of [
      ["feishu.app_secret", row.feishu_app_secret],
      ["feishu.token", row.feishu_token],
      ["feishu.encoding_aes_key", row.feishu_encoding_aes_key],
      ["feishu.route_token", routeToken],
    ] as const) {
      const secret = nullableString(value);
      if (secret !== null) await secrets.mutate({ tenantId, purpose: "bot", resourceId: botId, field }, { kind: "set", value: secret });
    }
  }
  for (const row of tasks) await client.query(`
    INSERT INTO control_bot_cron_tasks(bot_id, task_id, cron, task, entry_agent, enabled, push_platform, push_chat_id, next_run, last_run, last_result)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [row.bot_id, row.task_id, row.cron, row.task, row.entry_agent ?? null, Boolean(row.enabled), row.push_platform ?? null, row.push_chat_id ?? null, row.next_run ?? null, row.last_run ?? null, row.last_result ?? null]);
}

async function insertWidgets(client: PoolClient, apps: Row[], tokens: Row[], audits: Row[]): Promise<void> {
  for (const row of apps) await client.query("INSERT INTO control_widget_apps(app_key, tenant_id, secret_hash, secret_prefix, display_name, allowed_origins, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [row.app_key, row.tenant_id, row.secret_hash, row.secret_prefix, row.display_name, row.allowed_origins ?? "", row.created_at, row.revoked_at ?? null]);
  for (const row of tokens) await client.query("INSERT INTO control_widget_tokens(jti, app_key, issued_at, expires_at, revoked) VALUES ($1, $2, $3, $4, $5)", [row.jti, row.app_key, row.issued_at, row.expires_at, Boolean(row.revoked)]);
  for (const row of audits) await client.query("INSERT INTO control_widget_audit(id, app_key, action, actor, detail_json, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)", [row.id, row.app_key, row.action, row.actor, jsonOrNull(row.detail_json), row.created_at]);
}

function countRows(snapshot: ControlSnapshot): Record<string, number> {
  return Object.fromEntries(Object.entries(snapshot).map(([key, rows]) => [key, rows.length]));
}
function jsonOrNull(value: unknown): string | null { return value == null || value === "" ? null : typeof value === "string" ? value : JSON.stringify(value); }
function nullableString(value: unknown): string | null { return value == null || value === "" ? null : String(value); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function isUniqueViolation(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505"; }
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
