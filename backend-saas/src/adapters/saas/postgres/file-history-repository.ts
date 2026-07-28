import type { AsyncFileHistoryMetadataRepository, FileHistorySnapshot, FileHistoryTrackedFile } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export class PostgresFileHistoryMetadataRepository implements AsyncFileHistoryMetadataRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async putPending(tenantId: string, sessionId: string, fileKey: string, tracked: FileHistoryTrackedFile): Promise<boolean> {
    const result = await this.executor.query(
      "INSERT INTO file_history_pending(tenant_id,session_id,file_key,action,backup_hash,content_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,session_id,file_key) DO NOTHING",
      [tenantId, sessionId, fileKey, tracked.action, tracked.backup_hash, tracked.content_type ?? null],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async getPending(tenantId: string, sessionId: string): Promise<Record<string, FileHistoryTrackedFile>> {
    const result = await this.executor.query("SELECT file_key,action,backup_hash,content_type FROM file_history_pending WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,file_key", [tenantId, sessionId]);
    return Object.fromEntries(result.rows.map((row) => [String(row.file_key), toTracked(row)]));
  }

  async commitSnapshot(tenantId: string, sessionId: string, snapshot: FileHistorySnapshot): Promise<boolean> {
    return this.executor.transaction(async (tx) => {
      const pending = await tx.query("DELETE FROM file_history_pending WHERE tenant_id=$1 AND session_id=$2 RETURNING file_key,action,backup_hash,content_type", [tenantId, sessionId]);
      if (!pending.rows.length) return false;
      const trackedFiles = Object.fromEntries(pending.rows.map((row) => [String(row.file_key), toTracked(row)]));
      await tx.query(
        "INSERT INTO file_history_snapshots(tenant_id,session_id,snapshot_id,message_seq,tracked_files,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::timestamptz)",
        [tenantId, sessionId, snapshot.snapshot_id, snapshot.message_seq, JSON.stringify(trackedFiles), snapshot.created_at],
      );
      snapshot.tracked_files = trackedFiles;
      return true;
    });
  }

  async listSnapshots(tenantId: string, sessionId: string): Promise<FileHistorySnapshot[]> {
    const result = await this.executor.query("SELECT snapshot_id,message_seq,tracked_files,created_at FROM file_history_snapshots WHERE tenant_id=$1 AND session_id=$2 ORDER BY message_seq,created_at", [tenantId, sessionId]);
    return result.rows.map((row) => ({
      snapshot_id: String(row.snapshot_id),
      message_seq: Number(row.message_seq),
      tracked_files: (row.tracked_files ?? {}) as Record<string, FileHistoryTrackedFile>,
      created_at: new Date(String(row.created_at)).toISOString(),
    }));
  }

  async replaceSnapshots(tenantId: string, sessionId: string, snapshots: FileHistorySnapshot[]): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.query("DELETE FROM file_history_snapshots WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]);
      for (const snapshot of snapshots) {
        await tx.query("INSERT INTO file_history_snapshots(tenant_id,session_id,snapshot_id,message_seq,tracked_files,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::timestamptz)", [tenantId, sessionId, snapshot.snapshot_id, snapshot.message_seq, JSON.stringify(snapshot.tracked_files), snapshot.created_at]);
      }
      await tx.query("DELETE FROM file_history_pending WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]);
    });
  }

  async cleanup(tenantId: string, sessionId: string): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.query("DELETE FROM file_history_pending WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]);
      await tx.query("DELETE FROM file_history_snapshots WHERE tenant_id=$1 AND session_id=$2", [tenantId, sessionId]);
    });
  }
}

function toTracked(row: Record<string, unknown>): FileHistoryTrackedFile {
  return {
    action: row.action === "modified" ? "modified" : "created",
    backup_hash: row.backup_hash == null ? null : String(row.backup_hash),
    content_type: row.content_type == null ? null : String(row.content_type),
  };
}
