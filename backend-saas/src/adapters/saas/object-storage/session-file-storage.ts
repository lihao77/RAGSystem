import { randomUUID } from "node:crypto";

import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import type {
  AsyncSessionFileStorage,
  SessionFileMetadata,
  SessionFileMetadataRepository,
} from "@ragsystem/backend-core/contracts/session/session-file-storage.js";
import type { UploadedFileRecord } from "@ragsystem/backend-core/contracts/storage/files.js";

export class SaaSSessionFileStorage implements AsyncSessionFileStorage {
  constructor(
    private readonly tenantId: string,
    private readonly metadata: SessionFileMetadataRepository,
    private readonly objects: ObjectStorage,
  ) {
    if (!tenantId.trim()) throw new Error("SaaS session file storage requires a tenant id");
  }

  async list(sessionId: string): Promise<UploadedFileRecord[]> {
    return (await this.metadata.list(this.tenantId, requireSessionId(sessionId))).map(toRecord);
  }

  async get(sessionId: string, fileId: string): Promise<UploadedFileRecord | null> {
    const row = await this.metadata.get(this.tenantId, requireSessionId(sessionId), fileId);
    return row ? toRecord(row) : null;
  }

  async add(sessionId: string, input: { originalName: string; buffer: Uint8Array; mime: string }): Promise<UploadedFileRecord> {
    const scopedSessionId = requireSessionId(sessionId);
    const id = randomUUID();
    const storedName = `${id}_${sanitizeName(input.originalName)}`;
    const storageKey = `tenants/${encodeURIComponent(this.tenantId)}/sessions/${encodeURIComponent(scopedSessionId)}/attachments/${storedName}`;
    await this.objects.put(storageKey, input.buffer, input.mime);
    try {
      const row = await this.metadata.create({
        tenant_id: this.tenantId,
        id,
        original_name: input.originalName,
        stored_name: storedName,
        stored_path: storageKey,
        size: input.buffer.byteLength,
        mime: input.mime,
        uploaded_at: new Date().toISOString(),
        uploaded_by: null,
        indexed_in_vector: false,
        tags: null,
        notes: null,
        scope_type: "session",
        scope_id: scopedSessionId,
      });
      return toRecord(row);
    } catch (error) {
      await this.objects.delete(storageKey);
      throw error;
    }
  }

  async delete(sessionId: string, fileId: string): Promise<UploadedFileRecord | null> {
    const scopedSessionId = requireSessionId(sessionId);
    const row = await this.metadata.get(this.tenantId, scopedSessionId, fileId);
    if (!row) return null;
    await this.metadata.delete(this.tenantId, scopedSessionId, fileId);
    await this.objects.delete(row.stored_path);
    return toRecord(row);
  }

  async read(sessionId: string, fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const row = await this.metadata.get(this.tenantId, requireSessionId(sessionId), fileId);
    if (!row) return null;
    const object = await this.objects.get(row.stored_path);
    return object ? { body: object.body, contentType: object.metadata.contentType ?? row.mime } : null;
  }
}

function toRecord(row: SessionFileMetadata): UploadedFileRecord {
  const { tenant_id: _tenantId, ...record } = row;
  return record;
}

function requireSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId) throw new Error("SaaS session file storage requires a session id");
  return sessionId;
}

function sanitizeName(value: string): string {
  const name = value.trim().replace(/[\\/]+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return name.slice(0, 180) || "upload.bin";
}
