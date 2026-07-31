import { randomUUID } from "node:crypto";
import type { ArtifactMetadata, ArtifactMetadataRepository } from "../../contracts/artifact-repository.js";
import type { ArtifactApplication, ArtifactAssetInput, ArtifactContent, ArtifactRecord } from "../../contracts/artifact-application.js";
import type { ArtifactDescriptor, ArtifactSummary } from "../../contracts/artifacts.js";
import type { JsonValue } from "../../contracts/json.js";
import { ArtifactServiceError } from "../../artifact-error.js";
import type { ArtifactObjectStorage } from "./resources.js";

export class ObjectArtifactApplication implements ArtifactApplication {
  constructor(private readonly tenantId: string, private readonly metadata: ArtifactMetadataRepository, private readonly objects: ArtifactObjectStorage) {}

  async getArtifact(artifactId: string): Promise<ArtifactDescriptor> {
    const record = await this.require(artifactId); const object = await this.objects.get(record.descriptor_path);
    if (!object) throw new ArtifactServiceError(`artifact descriptor 不存在: ${artifactId}`, 404);
    let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(object.body)); } catch { throw new ArtifactServiceError(`artifact descriptor 无效: ${artifactId}`, 500); }
    if (!isRecord(parsed)) throw new ArtifactServiceError(`artifact descriptor 无效: ${artifactId}`, 500);
    return { ...parsed, content_url: record.asset_path ? `/api/artifacts/${encodeURIComponent(artifactId)}/content` : null } as ArtifactDescriptor;
  }

  async getArtifactContent(artifactId: string): Promise<ArtifactContent | null> {
    const record = await this.require(artifactId); if (!record.asset_path) return null; const object = await this.objects.get(record.asset_path);
    if (!object) throw new ArtifactServiceError(`artifact 内容不存在: ${artifactId}`, 404);
    const descriptor = await this.getArtifact(artifactId); const asset: Record<string, unknown> = isRecord(descriptor.asset) ? descriptor.asset as Record<string, unknown> : {};
    return { body: object.body, mimeType: record.mime_type ?? "application/octet-stream", filename: typeof asset.filename === "string" ? asset.filename : null };
  }

  async listArtifacts(sessionId: string): Promise<ArtifactSummary[]> {
    return (await this.metadata.list(this.tenantId, sessionId)).map((record) => ({ artifact_id: record.artifact_id, viz_type: record.viz_type, sub_type: record.sub_type, title: record.title, version: record.version, artifact_type: record.artifact_type, mime_type: record.mime_type, has_content: Boolean(record.asset_path), created_at: Date.parse(record.created_at) / 1000, updated_at: Date.parse(record.updated_at) / 1000 }));
  }
  async getArtifactSessionId(artifactId: string): Promise<string | null> { return (await this.metadata.get(this.tenantId, artifactId))?.session_id ?? null; }

  async createArtifact(input: { sessionId: string; vizType: string; subType?: string | null; title?: string | null; config?: JsonValue | null; asset?: ArtifactAssetInput | null }): Promise<ArtifactRecord> {
    if (!input.sessionId.trim() || !input.vizType.trim()) throw new ArtifactServiceError("创建 artifact 需要 session_id 和 viz_type");
    if (input.asset && (!input.asset.mimeType.trim() || input.asset.body.byteLength === 0)) throw new ArtifactServiceError("asset 必须包含非空 body 和 mimeType");
    const artifactId = `art_${randomUUID().replaceAll("-", "").slice(0, 12)}`; const prefix = `tenants/${this.tenantId}/sessions/${input.sessionId}/artifacts/${artifactId}`;
    const descriptorPath = `${prefix}.json`; const assetPath = input.asset ? `${prefix}.asset` : null;
    if (assetPath && input.asset) await this.objects.put(assetPath, input.asset.body, input.asset.mimeType);
    const descriptor: ArtifactDescriptor = { artifact_id: artifactId, viz_type: input.vizType.trim(), sub_type: input.subType?.trim() || "default", title: input.title?.trim() || "", version: 1, artifact_type: input.asset ? "binary" : "json", mime_type: input.asset?.mimeType ?? "application/json", content_url: assetPath ? `/api/artifacts/${encodeURIComponent(artifactId)}/content` : null, ...(input.asset ? { asset: { filename: input.asset.filename?.trim() || null, mime_type: input.asset.mimeType } } : {}), config: input.config ?? {} };
    await this.objects.put(descriptorPath, new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`), "application/json");
    return this.metadata.create({ tenant_id: this.tenantId, artifact_id: artifactId, session_id: input.sessionId, viz_type: descriptor.viz_type, sub_type: descriptor.sub_type, title: descriptor.title, version: 1, descriptor_path: descriptorPath, asset_path: assetPath, artifact_type: descriptor.artifact_type, mime_type: descriptor.mime_type, config: descriptor.config });
  }

  async reviseArtifact(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord> {
    const current = await this.require(input.artifactId); const descriptor = await this.getArtifact(input.artifactId); const nextConfig = input.replace ? input.configPatch : deepMerge(descriptor.config ?? {}, input.configPatch);
    const next = { ...descriptor, config: nextConfig, version: current.version + 1 }; await this.objects.put(current.descriptor_path, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`), "application/json");
    const updated = await this.metadata.updateVersion(this.tenantId, input.artifactId, current.version + 1, nextConfig); if (!updated) throw new ArtifactServiceError(`未找到 artifact: ${input.artifactId}`, 404); return updated;
  }
  async deleteArtifact(artifactId: string): Promise<boolean> { const current = await this.metadata.get(this.tenantId, artifactId); if (!current) return false; await this.objects.delete(current.descriptor_path); if (current.asset_path) await this.objects.delete(current.asset_path); await this.metadata.delete(this.tenantId, artifactId); return true; }
  async deleteSessionArtifacts(sessionId: string): Promise<number> { const rows = await this.metadata.list(this.tenantId, sessionId); for (const row of rows) { await this.objects.delete(row.descriptor_path); if (row.asset_path) await this.objects.delete(row.asset_path); await this.metadata.delete(this.tenantId, row.artifact_id); } return rows.length; }
  private async require(artifactId: string): Promise<ArtifactMetadata> { const record = await this.metadata.get(this.tenantId, artifactId); if (!record) throw new ArtifactServiceError(`未找到 artifact: ${artifactId}`, 404); return record; }
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function deepMerge(current: unknown, patch: unknown): JsonValue { if (!isRecord(current) || !isRecord(patch)) return patch as JsonValue; const result: Record<string, JsonValue> = { ...(current as Record<string, JsonValue>) }; for (const [key, value] of Object.entries(patch)) result[key] = deepMerge(result[key], value); return result; }
