import path from "node:path";

import { ArtifactServiceError } from "./artifact-error.js";
import type {
  ArtifactAssetInput,
  ArtifactCreateInput,
  ArtifactPresentationPatch,
  ArtifactRevisionInput,
} from "./contracts/artifact-application.js";
import type {
  ArtifactAsset,
  ArtifactManifest,
  ArtifactPresentation,
  ArtifactRelation,
  ArtifactStatus,
} from "./contracts/artifacts.js";
import type { JsonObject, JsonValue } from "./contracts/json.js";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/u;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_]+$/u;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface NormalizedArtifactCreateInput extends Omit<ArtifactCreateInput, "subtype" | "title" | "status" | "assets" | "presentations" | "metadata" | "provenance" | "relations"> {
  subtype: string;
  title: string;
  status: ArtifactStatus;
  assets: ArtifactAssetInput[];
  presentations: ArtifactPresentation[];
  metadata: JsonObject;
  provenance: JsonObject;
  relations: ArtifactRelation[];
}

export function normalizeCreateInput(input: ArtifactCreateInput): NormalizedArtifactCreateInput {
  const sessionId = requiredString(input.sessionId, "session_id");
  const kind = namespace(input.kind, "kind");
  const subtype = input.subtype == null ? "default" : namespace(input.subtype, "subtype");
  const title = optionalString(input.title, "title", 500);
  const status = artifactStatus(input.status ?? "ready");
  const assets = (input.assets ?? []).map(normalizeAssetInput);
  const assetIds = uniqueIds(assets.map((asset) => asset.assetId), "asset_id");
  const presentations = (input.presentations ?? []).map((item) => normalizePresentation(item, assetIds));
  uniqueIds(presentations.map((item) => item.presentation_id), "presentation_id");
  if (!assets.length && !presentations.length) throw new ArtifactServiceError("artifact 至少需要一个 asset 或 presentation");
  return {
    sessionId,
    kind,
    subtype,
    title,
    status,
    assets,
    presentations,
    metadata: jsonObject(input.metadata, "metadata"),
    provenance: jsonObject(input.provenance, "provenance"),
    relations: (input.relations ?? []).map(normalizeRelation),
  };
}

export function reviseManifest(current: ArtifactManifest, input: ArtifactRevisionInput, updatedAt: string): ArtifactManifest {
  const assetIds = new Set(current.assets.map((asset) => asset.asset_id));
  let presentations = input.presentations == null
    ? current.presentations
    : input.presentations.map((item) => normalizePresentation(item, assetIds));
  uniqueIds(presentations.map((item) => item.presentation_id), "presentation_id");
  for (const patch of input.presentationPatches ?? []) presentations = applyPresentationPatch(presentations, patch);
  return {
    ...current,
    revision: current.revision + 1,
    title: input.title == null ? current.title : optionalString(input.title, "title", 500),
    status: input.status == null ? current.status : artifactStatus(input.status),
    presentations,
    metadata: input.metadata == null ? current.metadata : input.replace ? jsonObject(input.metadata, "metadata") : deepMergeObject(current.metadata, input.metadata),
    provenance: input.provenance == null ? current.provenance : input.replace ? jsonObject(input.provenance, "provenance") : deepMergeObject(current.provenance, input.provenance),
    relations: input.relations == null ? current.relations : input.relations.map(normalizeRelation),
    updated_at: updatedAt,
  };
}

export function parseArtifactManifest(value: unknown): ArtifactManifest {
  if (!isRecord(value) || value.schema_version !== 2) throw new ArtifactServiceError("artifact manifest 不是 V2 格式", 500);
  const artifactId = requiredString(value.artifact_id, "artifact_id");
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new ArtifactServiceError("artifact_id 格式无效", 500);
  const revision = positiveInteger(value.revision, "revision");
  const sessionId = requiredString(value.session_id, "session_id");
  const kind = namespace(value.kind, "kind");
  const subtype = namespace(value.subtype, "subtype");
  const title = optionalString(value.title, "title", 500);
  const status = artifactStatus(value.status);
  if (!Array.isArray(value.assets) || !Array.isArray(value.presentations) || !Array.isArray(value.relations)) throw new ArtifactServiceError("artifact manifest 集合字段无效", 500);
  const assets = value.assets.map((item) => parseAsset(item, artifactId));
  const assetIds = uniqueIds(assets.map((asset) => asset.asset_id), "asset_id");
  const presentations = value.presentations.map((item) => normalizePresentation(item as ArtifactPresentation, assetIds));
  uniqueIds(presentations.map((item) => item.presentation_id), "presentation_id");
  if (!assets.length && !presentations.length) throw new ArtifactServiceError("artifact manifest 至少需要一个 asset 或 presentation", 500);
  const createdAt = isoDate(value.created_at, "created_at");
  const updatedAt = isoDate(value.updated_at, "updated_at");
  return {
    schema_version: 2,
    artifact_id: artifactId,
    revision,
    session_id: sessionId,
    kind,
    subtype,
    title,
    status,
    assets,
    presentations,
    metadata: jsonObject(value.metadata, "metadata"),
    provenance: jsonObject(value.provenance, "provenance"),
    relations: value.relations.map((item) => normalizeRelation(item as ArtifactRelation)),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function assetContentUrl(artifactId: string, assetId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/assets/${encodeURIComponent(assetId)}/content`;
}

export function storedAssetFilename(assetId: string, filename: string): string {
  const extension = path.extname(filename);
  return `${identifier(assetId, "asset_id")}${/^\.[A-Za-z0-9]{1,16}$/u.test(extension) ? extension.toLowerCase() : ".asset"}`;
}

export function safeAssetFilename(filename: string | null | undefined, assetId: string, mediaType: string): string {
  const normalized = typeof filename === "string" ? path.basename(filename.trim()).slice(0, 255) : "";
  return normalized || `${assetId}${extensionForMediaType(mediaType)}`;
}

export function namespace(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (normalized.length > 128 || !NAMESPACE_PATTERN.test(normalized)) throw new ArtifactServiceError(`${field} 必须是小写命名空间字符串`);
  return normalized;
}

export function identifier(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!ID_PATTERN.test(normalized)) throw new ArtifactServiceError(`${field} 格式无效`);
  return normalized;
}

export function jsonObject(value: unknown, field: string): JsonObject {
  if (value == null) return {};
  if (!isRecord(value)) throw new ArtifactServiceError(`${field} 必须是 JSON 对象`);
  return toJsonValue(value) as JsonObject;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ArtifactServiceError("JSON 数值必须是有限数");
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  throw new ArtifactServiceError("值不是有效 JSON");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAssetInput(asset: ArtifactAssetInput): ArtifactAssetInput {
  if (!isRecord(asset)) throw new ArtifactServiceError("asset 必须是对象");
  const assetId = identifier(asset.assetId, "asset_id");
  const role = namespace(asset.role, "asset.role");
  const mediaType = requiredString(asset.mediaType, "asset.media_type").toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) throw new ArtifactServiceError("asset.media_type 格式无效");
  if (!(asset.body instanceof Uint8Array) || asset.body.byteLength === 0) throw new ArtifactServiceError("asset.body 不能为空");
  return { assetId, role, mediaType, body: asset.body, filename: safeAssetFilename(asset.filename, assetId, mediaType) };
}

function parseAsset(value: unknown, artifactId: string): ArtifactAsset {
  if (!isRecord(value)) throw new ArtifactServiceError("artifact asset descriptor 无效", 500);
  const assetId = identifier(value.asset_id, "asset_id");
  const role = namespace(value.role, "asset.role");
  const filename = safeAssetFilename(requiredString(value.filename, "asset.filename"), assetId, requiredString(value.media_type, "asset.media_type"));
  const mediaType = requiredString(value.media_type, "asset.media_type").toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) throw new ArtifactServiceError("asset.media_type 格式无效", 500);
  const size = nonNegativeInteger(value.size, "asset.size");
  const sha256 = requiredString(value.sha256, "asset.sha256");
  if (!SHA256_PATTERN.test(sha256)) throw new ArtifactServiceError("asset.sha256 格式无效", 500);
  const contentUrl = requiredString(value.content_url, "asset.content_url");
  if (contentUrl !== assetContentUrl(artifactId, assetId)) throw new ArtifactServiceError("asset.content_url 必须指向当前 Artifact 内容路由", 500);
  return { asset_id: assetId, role, filename, media_type: mediaType, size, sha256, content_url: contentUrl };
}

function normalizePresentation(value: ArtifactPresentation, availableAssets: Set<string>): ArtifactPresentation {
  if (!isRecord(value)) throw new ArtifactServiceError("presentation 必须是对象");
  const presentationId = identifier(value.presentation_id, "presentation_id");
  const surface = namespace(value.surface, "presentation.surface");
  const renderer = namespace(value.renderer, "presentation.renderer");
  const refs = jsonObject(value.assets, "presentation.assets");
  const assets: Record<string, string> = {};
  for (const [role, assetId] of Object.entries(refs)) {
    const normalizedRole = namespace(role, "presentation asset role");
    const normalizedAssetId = identifier(assetId, `presentation.assets.${role}`);
    if (!availableAssets.has(normalizedAssetId)) throw new ArtifactServiceError(`presentation 引用了不存在的 asset: ${normalizedAssetId}`);
    assets[normalizedRole] = normalizedAssetId;
  }
  return { presentation_id: presentationId, surface, renderer, assets, config: toJsonValue(value.config ?? {}) };
}

function normalizeRelation(value: ArtifactRelation): ArtifactRelation {
  if (!isRecord(value)) throw new ArtifactServiceError("relation 必须是对象");
  const relation = namespace(value.relation, "relation");
  const targetId = requiredString(value.target_id, "relation.target_id");
  if (targetId.length > 255) throw new ArtifactServiceError("relation.target_id 过长");
  return { relation, target_id: targetId, ...(value.target_kind == null ? {} : { target_kind: namespace(value.target_kind, "relation.target_kind") }) };
}

function applyPresentationPatch(presentations: ArtifactPresentation[], patch: ArtifactPresentationPatch): ArtifactPresentation[] {
  const id = identifier(patch.presentationId, "presentation_id");
  const index = presentations.findIndex((item) => item.presentation_id === id);
  if (index < 0) throw new ArtifactServiceError(`未找到 presentation: ${id}`);
  return presentations.map((item, itemIndex) => itemIndex === index ? {
    ...item,
    config: patch.replace ? toJsonValue(patch.configPatch) : deepMerge(item.config, patch.configPatch),
  } : item);
}

function uniqueIds(values: string[], field: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new ArtifactServiceError(`${field} 不能重复`);
  return result;
}

function artifactStatus(value: unknown): ArtifactStatus {
  if (value !== "ready" && value !== "failed") throw new ArtifactServiceError("artifact.status 必须是 ready 或 failed");
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ArtifactServiceError(`${field} 必须是非空字符串`);
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum: number): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new ArtifactServiceError(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new ArtifactServiceError(`${field} 不能超过 ${maximum} 个字符`);
  return normalized;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new ArtifactServiceError(`${field} 必须是正整数`, 500);
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new ArtifactServiceError(`${field} 必须是非负整数`, 500);
  return Number(value);
}

function isoDate(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!Number.isFinite(Date.parse(normalized))) throw new ArtifactServiceError(`${field} 不是有效时间`, 500);
  return new Date(normalized).toISOString();
}

function deepMergeObject(current: JsonObject, patch: JsonObject): JsonObject {
  return deepMerge(current, patch) as JsonObject;
}

function deepMerge(current: JsonValue, patch: JsonValue): JsonValue {
  if (!isRecord(current) || !isRecord(patch)) return toJsonValue(patch);
  const result: JsonObject = { ...(current as JsonObject) };
  for (const [key, value] of Object.entries(patch)) result[key] = key in result ? deepMerge(result[key] ?? null, toJsonValue(value)) : toJsonValue(value);
  return result;
}

function extensionForMediaType(mediaType: string): string {
  const extensions: Record<string, string> = {
    "application/geo+json": ".geojson",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "image/geotiff": ".tif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/csv": ".csv",
  };
  return extensions[mediaType.toLowerCase()] ?? ".asset";
}
