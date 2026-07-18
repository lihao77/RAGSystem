import { createHash, randomUUID } from "node:crypto";

import type {
  AsyncFileHistoryMetadataRepository,
  AsyncFileHistoryStore,
  FileHistoryRewindResult,
  FileHistorySnapshot,
  FileHistoryTrackedFile,
} from "../../../contracts/file-history-store/index.js";
import type { ObjectStorage } from "../../../contracts/object-storage.js";

/** Tenant-bound file history. Both backup and restored targets are ObjectStorage keys. */
export class SaaSFileHistoryStorage implements AsyncFileHistoryStore {
  private readonly tenantPrefix: string;

  constructor(
    private readonly tenantId: string,
    private readonly metadata: AsyncFileHistoryMetadataRepository,
    private readonly objects: ObjectStorage,
  ) {
    if (!tenantId.trim()) throw new Error("SaaS file history requires a tenant id");
    this.tenantPrefix = `tenants/${encodeURIComponent(tenantId)}/`;
  }

  async trackEdit(input: { sessionId: string; fileKey: string; original: Uint8Array | null; contentType?: string | null }): Promise<void> {
    const sessionId = required(input.sessionId, "sessionId");
    const fileKey = required(input.fileKey, "fileKey");
    if (!fileKey.startsWith(this.tenantPrefix)) throw new Error("file history target must belong to the current tenant");
    const pending = await this.metadata.getPending(this.tenantId, sessionId);
    if (pending[fileKey]) return;

    let tracked: FileHistoryTrackedFile;
    if (input.original === null) {
      tracked = { action: "created", backup_hash: null, content_type: input.contentType ?? null };
    } else {
      const hash = createHash("sha256").update(input.original).digest("hex");
      await this.objects.put(this.backupKey(sessionId, hash), input.original, input.contentType ?? null);
      tracked = { action: "modified", backup_hash: hash, content_type: input.contentType ?? null };
    }
    await this.metadata.putPending(this.tenantId, sessionId, fileKey, tracked);
  }

  async makeSnapshot(sessionId: string, messageSeq: number): Promise<string | null> {
    sessionId = required(sessionId, "sessionId");
    if (!Number.isInteger(messageSeq)) return null;
    const snapshot: FileHistorySnapshot = {
      snapshot_id: randomUUID().replace(/-/g, "").slice(0, 16),
      message_seq: messageSeq,
      tracked_files: {},
      created_at: new Date().toISOString(),
    };
    return await this.metadata.commitSnapshot(this.tenantId, sessionId, snapshot) ? snapshot.snapshot_id : null;
  }

  async rewind(sessionId: string, targetSeq: number): Promise<FileHistoryRewindResult> {
    sessionId = required(sessionId, "sessionId");
    if (!Number.isInteger(targetSeq)) return { success: false, message: "invalid target sequence", reverted_files: 0 };
    const [snapshots, pending] = await Promise.all([
      this.metadata.listSnapshots(this.tenantId, sessionId),
      this.metadata.getPending(this.tenantId, sessionId),
    ]);
    const toRevert = snapshots.filter((item) => item.message_seq > targetSeq).sort((a, b) => a.message_seq - b.message_seq);
    const restore = new Map<string, FileHistoryTrackedFile>();
    for (const snapshot of toRevert) {
      for (const [key, tracked] of Object.entries(snapshot.tracked_files)) if (!restore.has(key)) restore.set(key, tracked);
    }
    for (const [key, tracked] of Object.entries(pending)) if (!restore.has(key)) restore.set(key, tracked);
    for (const [key, tracked] of restore) {
      if (tracked.action === "created" || !tracked.backup_hash) {
        await this.objects.delete(key);
        continue;
      }
      const backup = await this.objects.get(this.backupKey(sessionId, tracked.backup_hash));
      if (!backup) throw new Error(`file history backup not found: ${tracked.backup_hash}`);
      await this.objects.put(key, backup.body, tracked.content_type ?? backup.metadata.contentType);
    }
    await this.metadata.replaceSnapshots(this.tenantId, sessionId, snapshots.filter((item) => item.message_seq <= targetSeq));
    return { success: true, message: `restored ${restore.size} object(s) to seq=${targetSeq}`, reverted_files: restore.size };
  }

  async hasSnapshots(sessionId: string): Promise<boolean> {
    const [snapshots, pending] = await Promise.all([this.listSnapshots(sessionId), this.getPendingTracked(sessionId)]);
    return snapshots.length > 0 || pending !== null;
  }

  listSnapshots(sessionId: string): Promise<FileHistorySnapshot[]> {
    return this.metadata.listSnapshots(this.tenantId, required(sessionId, "sessionId"));
  }

  async getPendingTracked(sessionId: string): Promise<Record<string, FileHistoryTrackedFile> | null> {
    const pending = await this.metadata.getPending(this.tenantId, required(sessionId, "sessionId"));
    return Object.keys(pending).length ? pending : null;
  }

  async readBackup(sessionId: string, backupHash: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9]{64}$/.test(backupHash)) return null;
    return (await this.objects.get(this.backupKey(required(sessionId, "sessionId"), backupHash)))?.body ?? null;
  }

  async cleanup(sessionId: string): Promise<void> {
    sessionId = required(sessionId, "sessionId");
    const [snapshots, pending] = await Promise.all([
      this.metadata.listSnapshots(this.tenantId, sessionId),
      this.metadata.getPending(this.tenantId, sessionId),
    ]);
    const hashes = new Set<string>();
    for (const tracked of [...snapshots.flatMap((item) => Object.values(item.tracked_files)), ...Object.values(pending)]) {
      if (tracked.backup_hash) hashes.add(tracked.backup_hash);
    }
    await this.metadata.cleanup(this.tenantId, sessionId);
    await Promise.all([...hashes].map((hash) => this.objects.delete(this.backupKey(sessionId, hash))));
  }

  private backupKey(sessionId: string, hash: string): string {
    return `${this.tenantPrefix}file-history/${encodeURIComponent(sessionId)}/backups/${hash}`;
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
