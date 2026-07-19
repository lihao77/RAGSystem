import { describe, expect, it } from "vitest";
import { SaaSArtifactService } from "../../src/application/artifacts/saas-artifact-application.js";
import type { ArtifactMetadata, ArtifactMetadataRepository } from "../../src/contracts/artifact-repository.js";
import type { ObjectMetadata, ObjectStorage } from "../../src/contracts/object-storage.js";

class MemoryObjects implements ObjectStorage {
  readonly values = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> { this.values.set(key, body); return { key, contentType, contentLength: body.byteLength, etag: null }; }
  async get(key: string) { const body = this.values.get(key); return body ? { body, metadata: { key, contentType: "application/json", contentLength: body.byteLength, etag: null } } : null; }
  async head(key: string) { return this.values.has(key) ? { key, contentType: "application/json", contentLength: this.values.get(key)!.byteLength, etag: null } : null; }
  async delete(key: string) { return this.values.delete(key); }
}

class MemoryMetadata implements ArtifactMetadataRepository {
  readonly rows = new Map<string, ArtifactMetadata>();
  async get(_tenant: string, id: string) { return this.rows.get(id) ?? null; }
  async list(tenant: string, session?: string | null) { return [...this.rows.values()].filter((r) => r.tenant_id === tenant && (session == null || r.session_id === session)); }
  async create(input: any) { const now = new Date().toISOString(); const row = { ...input, created_at: now, updated_at: now }; this.rows.set(input.artifact_id, row); return row; }
  async updateVersion(_tenant: string, id: string, version: number, config?: any) { const row = this.rows.get(id); if (!row) return null; const next = { ...row, version, ...(config === undefined ? {} : { config }), updated_at: new Date().toISOString() }; this.rows.set(id, next); return next; }
  async delete(_tenant: string, id: string) { return this.rows.delete(id); }
}

describe("SaaSArtifactService", () => {
  it("stores, reads, revises and deletes artifact blobs through ObjectStorage", async () => {
    const objects = new MemoryObjects();
    const metadata = new MemoryMetadata();
    const service = new SaaSArtifactService("t1", metadata, objects);
    const created = await service.createChart({ sessionId: "s1", chartConfig: { x: [1] } });
    expect(created.file_path).toContain("tenants/t1/sessions/s1/artifacts/");
    await expect(service.getVisualization(created.artifact_id)).resolves.toMatchObject({ config: { x: [1] } });
    await service.reviseVisualization({ artifactId: created.artifact_id, configPatch: { y: 2 } });
    await expect(service.getVisualization(created.artifact_id)).resolves.toMatchObject({ config: { x: [1], y: 2 }, version: 2 });
    await expect(service.deleteVisualization(created.artifact_id)).resolves.toBe(true);
    expect(objects.values.size).toBe(0);
  });
});
