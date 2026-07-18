import type { FilesystemMemoryImportEntry } from "../../../services/memory-import/filesystem-memory-scanner.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export type MemoryImportConflictPolicy = "error" | "skip";

export interface PostgresMemoryImportResult {
  total: number;
  imported: number;
  skipped_identical: number;
  skipped_conflicts: number;
  verified: number;
  affected_scopes: number;
  records: Array<{
    source_relative_path: string;
    memory_id: string;
    outcome: "imported" | "identical" | "conflict_skipped";
  }>;
}

/** Offline writer that preserves Local entry identity, status, timestamps and source metadata. */
export class PostgresMemoryImporter {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async importEntries(
    tenantId: string,
    entries: readonly FilesystemMemoryImportEntry[],
    conflictPolicy: MemoryImportConflictPolicy = "error",
  ): Promise<PostgresMemoryImportResult> {
    if (entries.some((entry) => entry.tenant_id !== tenantId)) {
      throw new Error("Memory import contains an entry for a different tenant");
    }
    return this.executor.transaction(async (tx) => {
      let imported = 0;
      let skippedIdentical = 0;
      let skippedConflicts = 0;
      const affectedScopes = new Map<string, FilesystemMemoryImportEntry>();
      const expectedEntries = new Map<string, FilesystemMemoryImportEntry>();
      const records: PostgresMemoryImportResult["records"] = [];
      for (const entry of entries) {
        const inserted = await tx.query<{ id: string }>(`
          INSERT INTO memory_entries (
            id, tenant_id, scope, scope_id, name, description, memory_type, content,
            why, how_to_apply, status, source_run_id, source_message_id, version,
            created_at, updated_at, archived_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT DO NOTHING
          RETURNING id
        `, entryParams(entry));
        if (inserted.rows[0]) {
          imported += 1;
          expectedEntries.set(entry.id, entry);
          affectedScopes.set(scopeKey(entry), entry);
          records.push({
            source_relative_path: entry.source_relative_path,
            memory_id: entry.id,
            outcome: "imported",
          });
          continue;
        }

        const existing = await tx.query("SELECT * FROM memory_entries WHERE tenant_id = $1 AND id = $2", [tenantId, entry.id]);
        if (existing.rows[0] && sameEntry(existing.rows[0], entry)) {
          skippedIdentical += 1;
          expectedEntries.set(entry.id, entry);
          records.push({
            source_relative_path: entry.source_relative_path,
            memory_id: entry.id,
            outcome: "identical",
          });
          continue;
        }
        if (conflictPolicy === "skip") {
          skippedConflicts += 1;
          records.push({
            source_relative_path: entry.source_relative_path,
            memory_id: entry.id,
            outcome: "conflict_skipped",
          });
          continue;
        }
        throw new Error(`Memory import conflict at ${entry.source_relative_path}`);
      }

      for (const entry of affectedScopes.values()) {
        await tx.query(`
          INSERT INTO memory_scope_revisions (tenant_id, scope, scope_id, revision)
          VALUES ($1,$2,$3,1)
          ON CONFLICT (tenant_id, scope, scope_id) DO UPDATE
          SET revision = memory_scope_revisions.revision + 1, updated_at = CURRENT_TIMESTAMP
        `, [tenantId, entry.scope, entry.scope_id]);
      }

      let verified = 0;
      if (expectedEntries.size > 0) {
        const result = await tx.query(
          "SELECT * FROM memory_entries WHERE tenant_id = $1 AND id = ANY($2::text[])",
          [tenantId, [...expectedEntries.keys()]],
        );
        const rowsById = new Map(result.rows.map((row) => [String(row.id), row]));
        for (const [id, entry] of expectedEntries) {
          const row = rowsById.get(id);
          if (!row || !sameEntry(row, entry)) {
            throw new Error(`Memory import verification mismatch at ${entry.source_relative_path}`);
          }
          verified += 1;
        }
      }
      return {
        total: entries.length,
        imported,
        skipped_identical: skippedIdentical,
        skipped_conflicts: skippedConflicts,
        verified,
        affected_scopes: affectedScopes.size,
        records,
      };
    });
  }
}

function entryParams(entry: FilesystemMemoryImportEntry): readonly unknown[] {
  return [
    entry.id, entry.tenant_id, entry.scope, entry.scope_id, entry.name, entry.description,
    entry.memory_type, entry.content, entry.why, entry.how_to_apply, entry.status,
    entry.source_run_id, entry.source_message_id, entry.version, entry.created_at,
    entry.updated_at, entry.archived_at,
  ];
}

function sameEntry(row: Record<string, unknown>, entry: FilesystemMemoryImportEntry): boolean {
  return String(row.tenant_id) === entry.tenant_id
    && String(row.id) === entry.id
    && String(row.scope) === entry.scope
    && String(row.scope_id) === entry.scope_id
    && String(row.name) === entry.name
    && String(row.description) === entry.description
    && String(row.memory_type) === entry.memory_type
    && String(row.content) === entry.content
    && nullableString(row.why) === entry.why
    && nullableString(row.how_to_apply) === entry.how_to_apply
    && String(row.status) === entry.status
    && nullableString(row.source_run_id) === entry.source_run_id
    && nullableString(row.source_message_id) === entry.source_message_id
    && Number(row.version) === entry.version
    && isoString(row.created_at) === entry.created_at
    && isoString(row.updated_at) === entry.updated_at
    && nullableIsoString(row.archived_at) === entry.archived_at;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function isoString(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function nullableIsoString(value: unknown): string | null {
  return value == null ? null : isoString(value);
}

function scopeKey(entry: FilesystemMemoryImportEntry): string {
  return `${entry.scope}:${entry.scope_id}`;
}
