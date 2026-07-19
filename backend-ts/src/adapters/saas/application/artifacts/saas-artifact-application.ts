import type { JsonValue } from "../../../../contracts/common.js";
import { randomUUID } from "node:crypto";
import type { ObjectStorage } from "../../../../contracts/storage/object-storage.js";
import type { ArtifactMetadata, ArtifactMetadataRepository } from "../../../../contracts/artifacts/artifact-repository.js";
import type { VisualizationConfig, VisualizationSummary } from "../../../../contracts/artifacts/artifacts.js";
import type { ArtifactApplication, ArtifactRecord } from "../../../../contracts/artifacts/artifact-application.js";
import { ArtifactServiceError } from "../../../../services/artifacts/artifact-service.js";

/** Async tenant-scoped artifact service for SaaS deployments. Metadata lives in PostgreSQL; blobs live in ObjectStorage. */
export class SaaSArtifactService implements ArtifactApplication {
  constructor(
    private readonly tenantId: string,
    private readonly metadata: ArtifactMetadataRepository,
    private readonly objects: ObjectStorage,
  ) {}

  async getVisualization(artifactId: string): Promise<VisualizationConfig> {
    const record = await this.require(artifactId);
    const object = await this.objects.get(record.file_path);
    if (!object) throw new ArtifactServiceError(`可视化 artifact 文件不存在: ${artifactId}`, 404);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(object.body)); } catch { throw new ArtifactServiceError(`可视化 artifact 配置无效: ${artifactId}`, 500); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ArtifactServiceError(`可视化 artifact 配置无效: ${artifactId}`, 500);
    return parsed as VisualizationConfig;
  }

  async listVisualizations(sessionId: string): Promise<VisualizationSummary[]> {
    const rows = await this.metadata.list(this.tenantId, sessionId);
    return rows.map((record) => ({ artifact_id: record.artifact_id, viz_type: record.viz_type, sub_type: record.sub_type, title: record.title, version: record.version, created_at: Date.parse(record.created_at) / 1000, updated_at: Date.parse(record.updated_at) / 1000 }));
  }

  async getVisualizationSessionId(artifactId: string): Promise<string | null> {
    return (await this.metadata.get(this.tenantId, artifactId))?.session_id ?? null;
  }

  async createChart(input: { sessionId: string; chartConfig: JsonValue; chartType?: string | null; title?: string | null }): Promise<ArtifactRecord> {
    return this.create(input.sessionId, "chart", input.chartType ?? "bar", input.title ?? "", input.chartConfig);
  }

  async createMap(input: { sessionId: string; mapData: JsonValue; mapType?: string | null; title?: string | null }): Promise<ArtifactRecord> {
    return this.create(input.sessionId, "map", input.mapType ?? "marker", input.title ?? "", input.mapData);
  }

  async reviseVisualization(input: { artifactId: string; configPatch: JsonValue; replace?: boolean | null }): Promise<ArtifactRecord> {
    const current = await this.require(input.artifactId);
    if (current.viz_type === "image") throw new ArtifactServiceError("图片类型的 artifact 不支持修改配置");
    const payload = await this.getVisualization(input.artifactId);
    const nextConfig = input.replace ? input.configPatch : deepMerge(payload.config ?? {}, input.configPatch);
    const next = { ...payload, config: nextConfig, version: current.version + 1 };
    await this.objects.put(current.file_path, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`), current.mime_type ?? "application/json");
    const updated = await this.metadata.updateVersion(this.tenantId, input.artifactId, current.version + 1, nextConfig);
    if (!updated) throw new ArtifactServiceError(`未找到可视化 artifact: ${input.artifactId}`, 404);
    return updated;
  }

  async deleteVisualization(artifactId: string): Promise<boolean> {
    const current = await this.metadata.get(this.tenantId, artifactId);
    if (!current) return false;
    await this.objects.delete(current.file_path);
    await this.metadata.delete(this.tenantId, artifactId);
    return true;
  }

  async deleteSessionVisualizations(sessionId: string): Promise<number> {
    const rows = await this.metadata.list(this.tenantId, sessionId);
    for (const row of rows) await this.objects.delete(row.file_path);
    for (const row of rows) await this.metadata.delete(this.tenantId, row.artifact_id);
    return rows.length;
  }

  private async create(sessionId: string, vizType: string, subType: string, title: string, config: JsonValue): Promise<ArtifactMetadata> {
    if (!sessionId.trim()) throw new ArtifactServiceError("创建可视化 artifact 需要 session_id");
    const artifactId = `viz_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const key = `tenants/${this.tenantId}/sessions/${sessionId}/artifacts/${artifactId}.json`;
    const payload = { artifact_id: artifactId, viz_type: vizType, sub_type: subType, title, version: 1, config };
    await this.objects.put(key, new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`), "application/json");
    return this.metadata.create({ tenant_id: this.tenantId, artifact_id: artifactId, session_id: sessionId, viz_type: vizType, sub_type: subType, title, version: 1, file_path: key, artifact_type: "json", mime_type: "application/json", config });
  }

  private async require(artifactId: string): Promise<ArtifactMetadata> {
    const record = await this.metadata.get(this.tenantId, artifactId);
    if (!record) throw new ArtifactServiceError(`未找到可视化 artifact: ${artifactId}`, 404);
    return record;
  }
}

function deepMerge(current: unknown, patch: unknown): JsonValue {
  if (!current || typeof current !== "object" || Array.isArray(current) || !patch || typeof patch !== "object" || Array.isArray(patch)) return patch as JsonValue;
  const result: Record<string, JsonValue> = { ...(current as Record<string, JsonValue>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) result[key] = deepMerge(result[key], value);
  return result;
}
