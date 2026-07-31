import { createHash, randomUUID } from "node:crypto";

import { ArtifactServiceError } from "../../artifact-error.js";
import {
  assetContentUrl,
  normalizeCreateInput,
  parseArtifactManifest,
  reviseManifest,
  storedAssetFilename,
} from "../../artifact-model.js";
import type {
  ArtifactApplication,
  ArtifactAssetContent,
  ArtifactCreateInput,
  ArtifactRecord,
  ArtifactRevisionInput,
} from "../../contracts/artifact-application.js";
import type { ArtifactMetadata, ArtifactMetadataRepository } from "../../contracts/artifact-repository.js";
import type { ArtifactAsset, ArtifactManifest, ArtifactSummary } from "../../contracts/artifacts.js";
import type { ArtifactObjectStorage } from "./resources.js";

export class ObjectArtifactApplication implements ArtifactApplication {
  constructor(
    private readonly tenantId: string,
    private readonly metadata: ArtifactMetadataRepository,
    private readonly objects: ArtifactObjectStorage,
  ) {}

  async getArtifact(artifactId: string): Promise<ArtifactManifest> {
    const record = await this.require(artifactId);
    const object = await this.objects.get(record.manifest_path);
    if (!object) throw new ArtifactServiceError(`artifact manifest 不存在: ${artifactId}`, 404);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(object.body)); }
    catch { throw new ArtifactServiceError(`artifact manifest JSON 无效: ${artifactId}`, 500); }
    const manifest = parseArtifactManifest(parsed);
    if (manifest.artifact_id !== artifactId || manifest.session_id !== record.session_id) throw new ArtifactServiceError(`artifact manifest 与元数据不一致: ${artifactId}`, 500);
    return manifest;
  }

  async getArtifactAsset(artifactId: string, assetId: string): Promise<ArtifactAssetContent> {
    const record = await this.require(artifactId);
    const manifest = await this.getArtifact(artifactId);
    const asset = manifest.assets.find((item) => item.asset_id === assetId);
    if (!asset) throw new ArtifactServiceError(`artifact asset 不存在: ${artifactId}/${assetId}`, 404);
    const object = await this.objects.get(assetObjectKey(record.manifest_path, asset));
    if (!object) throw new ArtifactServiceError(`artifact asset 内容不存在: ${artifactId}/${assetId}`, 404);
    return { body: object.body, mediaType: asset.media_type, filename: asset.filename, sha256: asset.sha256 };
  }

  async listArtifacts(sessionId: string): Promise<ArtifactSummary[]> {
    return (await this.metadata.list(this.tenantId, sessionId)).map(summary);
  }

  async getArtifactSessionId(artifactId: string): Promise<string | null> {
    return (await this.metadata.get(this.tenantId, artifactId))?.session_id ?? null;
  }

  async createArtifact(input: ArtifactCreateInput): Promise<ArtifactRecord> {
    const normalized = normalizeCreateInput(input);
    const artifactId = `art_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const prefix = `tenants/${encodeURIComponent(this.tenantId)}/sessions/${encodeURIComponent(normalized.sessionId)}/artifacts/${artifactId}`;
    const manifestPath = `${prefix}/manifest.json`;
    const now = new Date().toISOString();
    const writtenKeys: string[] = [];
    try {
      const assets: ArtifactAsset[] = [];
      for (const inputAsset of normalized.assets) {
        const filename = inputAsset.filename as string;
        const asset: ArtifactAsset = {
          asset_id: inputAsset.assetId,
          role: inputAsset.role,
          filename,
          media_type: inputAsset.mediaType,
          size: inputAsset.body.byteLength,
          sha256: createHash("sha256").update(inputAsset.body).digest("hex"),
          content_url: assetContentUrl(artifactId, inputAsset.assetId),
        };
        const key = assetObjectKey(manifestPath, asset);
        await this.objects.put(key, inputAsset.body, inputAsset.mediaType);
        writtenKeys.push(key);
        assets.push(asset);
      }
      const manifest: ArtifactManifest = {
        schema_version: 2,
        artifact_id: artifactId,
        revision: 1,
        session_id: normalized.sessionId,
        kind: normalized.kind,
        subtype: normalized.subtype,
        title: normalized.title,
        status: normalized.status,
        assets,
        presentations: normalized.presentations,
        metadata: normalized.metadata,
        provenance: normalized.provenance,
        relations: normalized.relations,
        created_at: now,
        updated_at: now,
      };
      await this.objects.put(manifestPath, encodeJson(manifest), "application/json");
      writtenKeys.push(manifestPath);
      return record(await this.metadata.create({
        tenant_id: this.tenantId,
        schema_version: 2,
        artifact_id: artifactId,
        session_id: normalized.sessionId,
        kind: normalized.kind,
        subtype: normalized.subtype,
        title: normalized.title,
        status: normalized.status,
        revision: 1,
        manifest_path: manifestPath,
        asset_count: assets.length,
        presentation_count: normalized.presentations.length,
        created_at: now,
        updated_at: now,
      }));
    } catch (error) {
      for (const key of writtenKeys.reverse()) await this.objects.delete(key).catch(() => false);
      throw error;
    }
  }

  async reviseArtifact(input: ArtifactRevisionInput): Promise<ArtifactRecord> {
    const currentMetadata = await this.require(input.artifactId);
    const currentObject = await this.objects.get(currentMetadata.manifest_path);
    if (!currentObject) throw new ArtifactServiceError(`artifact manifest 不存在: ${input.artifactId}`, 404);
    const current = parseArtifactManifest(JSON.parse(new TextDecoder().decode(currentObject.body)) as unknown);
    const next = reviseManifest(current, input, new Date().toISOString());
    await this.objects.put(currentMetadata.manifest_path, encodeJson(next), "application/json");
    try {
      const updated = await this.metadata.updateRevision({
        tenantId: this.tenantId,
        artifactId: input.artifactId,
        revision: next.revision,
        title: next.title,
        status: next.status,
        presentationCount: next.presentations.length,
      });
      if (!updated) throw new ArtifactServiceError(`未找到 artifact: ${input.artifactId}`, 404);
      return record(updated);
    } catch (error) {
      await this.objects.put(currentMetadata.manifest_path, currentObject.body, "application/json").catch(() => undefined);
      throw error;
    }
  }

  async deleteArtifact(artifactId: string): Promise<boolean> {
    const current = await this.metadata.get(this.tenantId, artifactId);
    if (!current) return false;
    const manifest = await this.getArtifact(artifactId);
    for (const asset of manifest.assets) await this.objects.delete(assetObjectKey(current.manifest_path, asset));
    await this.objects.delete(current.manifest_path);
    await this.metadata.delete(this.tenantId, artifactId);
    return true;
  }

  async deleteSessionArtifacts(sessionId: string): Promise<number> {
    const rows = await this.metadata.list(this.tenantId, sessionId);
    for (const row of rows) await this.deleteArtifact(row.artifact_id);
    return rows.length;
  }

  private async require(artifactId: string): Promise<ArtifactMetadata> {
    const record = await this.metadata.get(this.tenantId, artifactId);
    if (!record) throw new ArtifactServiceError(`未找到 artifact: ${artifactId}`, 404);
    return record;
  }
}

function assetObjectKey(manifestPath: string, asset: ArtifactAsset): string {
  const separator = manifestPath.lastIndexOf("/");
  const prefix = separator < 0 ? "" : manifestPath.slice(0, separator);
  return `${prefix}/assets/${storedAssetFilename(asset.asset_id, asset.filename)}`;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function record(metadata: ArtifactMetadata): ArtifactRecord {
  const { tenant_id: _tenantId, ...rest } = metadata;
  return rest;
}

function summary(metadata: ArtifactMetadata): ArtifactSummary {
  const { tenant_id: _tenantId, manifest_path: _manifestPath, ...rest } = metadata;
  return rest;
}
