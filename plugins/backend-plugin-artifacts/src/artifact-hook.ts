import type { ToolAfterInput, ToolAfterOutput, ToolExecutionResult } from "@ragsystem/agent-sdk";

import type { ArtifactsPluginDependencies } from "./dependencies.js";
import { toJsonValue, isRecord } from "./artifact-model.js";
import type {
  ArtifactApplication,
  ArtifactAssetInput,
  ArtifactCreateInput,
  ArtifactPresentationPatch,
  ArtifactRecord,
} from "./contracts/artifact-application.js";
import type { ArtifactPresentation, ArtifactRelation, ArtifactStatus } from "./contracts/artifacts.js";
import type { JsonObject } from "./contracts/json.js";

const MAX_EMBEDDED_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_EMBEDDED_ASSET_TOTAL_BYTES = 128 * 1024 * 1024;

export function createArtifactToolAfterHook(
  dependencies: Pick<ArtifactsPluginDependencies, "storage">,
): (input: ToolAfterInput) => Promise<ToolAfterOutput | void> {
  return async ({ toolName, result, ctx }) => {
    if (toolName !== "execute_skill_script" || !result.success || !isRecord(result.content) || !("artifact" in result.content)) return;
    const { artifact: rawArtifact, ...content } = result.content;
    const fail = (message: string): ToolAfterOutput => ({ modifiedResult: replace(result, content, { ...result.metadata, artifact_error: message }) });
    if (!isRecord(rawArtifact)) return fail("artifact 字段必须是对象");
    const tenantId = normalizeString(ctx.tenantId);
    if (!tenantId) return fail("Artifact 插件需要 tenant_id");
    try {
      const persisted = await persistArtifact(
        await dependencies.storage.applicationForTenant(tenantId),
        rawArtifact,
        normalizeString(ctx.sessionId),
      );
      if ("error" in persisted) return fail(persisted.error);
      const info = persisted.record;
      return {
        modifiedResult: {
          ...replace(result, {
            ...content,
            artifact_id: info.artifact_id,
            artifact_kind: info.kind,
            artifact_revision: info.revision,
            artifact_status: info.status,
            asset_count: info.asset_count,
            presentation_count: info.presentation_count,
          }, {
            ...result.metadata,
            artifact_id: info.artifact_id,
            artifact_persisted: true,
          }),
          outputType: info.kind,
          llmHint: `在 <final_answer> 中插入 [artifact:${info.artifact_id}] 来展示此产物`,
        },
      };
    } catch (error) {
      return fail(`artifact 持久化失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

async function persistArtifact(
  artifacts: ArtifactApplication,
  raw: Record<string, unknown>,
  sessionId: string | null,
): Promise<{ record: ArtifactRecord } | { error: string }> {
  if (raw.schema_version !== 2) return { error: "artifact.schema_version 必须是 2" };
  const action = normalizeString(raw.action) ?? "create";
  if (action === "revise") {
    const artifactId = normalizeString(raw.artifact_id);
    if (!artifactId) return { error: "revise 操作需要 artifact_id" };
    if (!sessionId) return { error: "revise 操作需要 session_id" };
    const current = await artifacts.getArtifact(artifactId);
    if (current.session_id !== sessionId) return { error: "不能修改其他 session 的 artifact" };
    const patch = parseRevisionPatch(raw);
    return { record: await artifacts.reviseArtifact({ artifactId, ...patch }) };
  }
  if (action !== "create") return { error: `不支持的 artifact action: ${action}` };
  if (!sessionId) return { error: "创建 artifact 需要 session_id" };
  const kind = normalizeString(raw.kind);
  if (!kind) return { error: "artifact 需要 kind" };
  const assets = decodeAssets(raw.assets);
  if ("error" in assets) return assets;
  const presentations = parsePresentations(raw.presentations);
  if ("error" in presentations) return presentations;
  const input = {
    sessionId,
    kind,
    subtype: normalizeString(raw.subtype),
    title: normalizeString(raw.title),
    status: raw.status == null ? null : raw.status as ArtifactStatus,
    assets: assets.value,
    presentations: presentations.value,
    metadata: jsonObjectOrError(raw.metadata, "metadata"),
    provenance: jsonObjectOrError(raw.provenance, "provenance"),
    relations: parseRelations(raw.relations),
  };
  if ("error" in input.metadata) return input.metadata;
  if ("error" in input.provenance) return input.provenance;
  const createInput: ArtifactCreateInput = {
    sessionId: input.sessionId,
    kind: input.kind,
    subtype: input.subtype,
    title: input.title,
    status: input.status,
    assets: input.assets,
    presentations: input.presentations,
    relations: input.relations,
    metadata: input.metadata.value,
    provenance: input.provenance.value,
  };
  return { record: await artifacts.createArtifact(createInput) };
}

function decodeAssets(value: unknown): { value: ArtifactAssetInput[] } | { error: string } {
  if (value == null) return { value: [] };
  if (!Array.isArray(value)) return { error: "artifact.assets 必须是数组" };
  let total = 0;
  const result: ArtifactAssetInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { error: "artifact.assets 的成员必须是对象" };
    const assetId = normalizeString(item.asset_id);
    const role = normalizeString(item.role);
    const mediaType = normalizeString(item.media_type);
    const data = normalizeString(item.data_base64);
    if (!assetId || !role || !mediaType || !data) return { error: "asset 需要 asset_id、role、media_type 和 data_base64" };
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) return { error: `asset ${assetId} 的 data_base64 格式无效` };
    const body = Buffer.from(data, "base64");
    if (!body.byteLength) return { error: `asset ${assetId} 内容不能为空` };
    if (body.byteLength > MAX_EMBEDDED_ASSET_BYTES) return { error: `asset ${assetId} 不能超过 ${MAX_EMBEDDED_ASSET_BYTES} 字节` };
    total += body.byteLength;
    if (total > MAX_EMBEDDED_ASSET_TOTAL_BYTES) return { error: `artifact 内联 Asset 总大小不能超过 ${MAX_EMBEDDED_ASSET_TOTAL_BYTES} 字节` };
    result.push({ assetId, role, body, mediaType, filename: normalizeString(item.filename) });
  }
  return { value: result };
}

function parsePresentations(value: unknown): { value: ArtifactPresentation[] } | { error: string } {
  if (value == null) return { value: [] };
  if (!Array.isArray(value)) return { error: "artifact.presentations 必须是数组" };
  try {
    return {
      value: value.map((item) => {
        if (!isRecord(item)) throw new Error("presentation 必须是对象");
        if (!isRecord(item.assets)) throw new Error("presentation.assets 必须是对象");
        return {
          presentation_id: normalizeRequired(item.presentation_id, "presentation_id"),
          surface: normalizeRequired(item.surface, "presentation.surface"),
          renderer: normalizeRequired(item.renderer, "presentation.renderer"),
          assets: Object.fromEntries(Object.entries(item.assets).map(([key, assetId]) => [key, normalizeRequired(assetId, `presentation.assets.${key}`)])),
          config: toJsonValue(item.config ?? {}),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function parseRevisionPatch(raw: Record<string, unknown>): {
  title?: string | null;
  status?: ArtifactStatus | null;
  metadata?: JsonObject | null;
  provenance?: JsonObject | null;
  relations?: ArtifactRelation[] | null;
  presentations?: ArtifactPresentation[] | null;
  presentationPatches?: ArtifactPresentationPatch[] | null;
  replace?: boolean | null;
} {
  const patch = isRecord(raw.patch) ? raw.patch : {};
  const presentationPatches = raw.presentation_patches == null ? undefined : parsePresentationPatches(raw.presentation_patches);
  if (presentationPatches && "error" in presentationPatches) throw new Error(presentationPatches.error);
  const presentations = patch.presentations == null ? undefined : parsePresentations(patch.presentations);
  if (presentations && "error" in presentations) throw new Error(presentations.error);
  const metadata = jsonObjectOrError(patch.metadata, "metadata");
  if ("error" in metadata) throw new Error(metadata.error);
  const provenance = jsonObjectOrError(patch.provenance, "provenance");
  if ("error" in provenance) throw new Error(provenance.error);
  const result: {
    title?: string | null;
    status?: ArtifactStatus | null;
    metadata?: JsonObject | null;
    provenance?: JsonObject | null;
    relations?: ArtifactRelation[] | null;
    presentations?: ArtifactPresentation[] | null;
    presentationPatches?: ArtifactPresentationPatch[] | null;
    replace?: boolean | null;
  } = { replace: raw.replace === true };
  if (patch.title != null) result.title = normalizeRequired(patch.title, "title");
  if (patch.status != null) result.status = patch.status as ArtifactStatus;
  if (patch.metadata != null) result.metadata = metadata.value;
  if (patch.provenance != null) result.provenance = provenance.value;
  if (patch.relations != null) result.relations = parseRelations(patch.relations);
  if (presentations && "value" in presentations) result.presentations = presentations.value;
  if (presentationPatches && "value" in presentationPatches) result.presentationPatches = presentationPatches.value;
  return result;
}

function parsePresentationPatches(value: unknown): { value: ArtifactPresentationPatch[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "presentation_patches 必须是数组" };
  try {
    return { value: value.map((item) => {
      if (!isRecord(item)) throw new Error("presentation patch 必须是对象");
      return {
        presentationId: normalizeRequired(item.presentation_id, "presentation_id"),
        configPatch: toJsonValue(item.config ?? {}),
        replace: item.replace === true,
      };
    }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function parseRelations(value: unknown): ArtifactRelation[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("artifact.relations 必须是数组");
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("relation 必须是对象");
    return {
      relation: normalizeRequired(item.relation, "relation"),
      target_id: normalizeRequired(item.target_id, "relation.target_id"),
      ...(item.target_kind == null ? {} : { target_kind: normalizeRequired(item.target_kind, "relation.target_kind") }),
    };
  });
}

function jsonObjectOrError(value: unknown, field: string): { value: JsonObject } | { error: string } {
  if (value == null) return { value: {} };
  if (!isRecord(value)) return { error: `${field} 必须是 JSON 对象` };
  try { return { value: toJsonValue(value) as JsonObject }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function normalizeRequired(value: unknown, field: string): string {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${field} 必须是非空字符串`);
  return normalized;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function replace(result: ToolExecutionResult, content: Record<string, unknown>, metadata: Record<string, unknown>): ToolExecutionResult {
  return { ...result, content, metadata };
}
