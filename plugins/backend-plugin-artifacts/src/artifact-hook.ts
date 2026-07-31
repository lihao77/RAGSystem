import type { ToolAfterInput, ToolAfterOutput, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { ArtifactsPluginDependencies } from "./dependencies.js";
import type { ArtifactApplication, ArtifactAssetInput, ArtifactRecord } from "./contracts/artifact-application.js";
import type { JsonValue } from "./contracts/json.js";

const MAX_EMBEDDED_ASSET_BYTES = 32 * 1024 * 1024;

export function createArtifactToolAfterHook(dependencies: Pick<ArtifactsPluginDependencies, "storage">): (input: ToolAfterInput) => Promise<ToolAfterOutput | void> {
  return async ({ toolName, result, ctx }) => {
    if (toolName !== "execute_skill_script" || !result.success || !isRecord(result.content) || !("artifact" in result.content)) return;
    const { artifact: rawArtifact, ...content } = result.content;
    const fail = (message: string): ToolAfterOutput => ({ modifiedResult: replace(result, content, { ...result.metadata, artifact_error: message }) });
    if (!isRecord(rawArtifact)) return fail("artifact 字段必须是对象");
    const tenantId = normalizeString(ctx.tenantId); if (!tenantId) return fail("Artifact 插件需要 tenant_id");
    try {
      const persisted = await persistArtifact(await dependencies.storage.applicationForTenant(tenantId), rawArtifact, normalizeString(ctx.sessionId));
      if ("error" in persisted) return fail(persisted.error);
      const info = persisted.record;
      return { modifiedResult: { ...replace(result, { ...content, artifact_id: info.artifact_id, viz_type: info.viz_type, artifact_type: info.artifact_type, mime_type: info.mime_type }, { ...result.metadata, artifact_id: info.artifact_id, artifact_persisted: true }), outputType: info.viz_type, llmHint: `在 <final_answer> 中插入 [artifact:${info.artifact_id}] 来展示此产物` } };
    } catch (error) { return fail(`artifact 持久化失败: ${error instanceof Error ? error.message : String(error)}`); }
  };
}

async function persistArtifact(artifacts: ArtifactApplication, raw: Record<string, unknown>, sessionId: string | null): Promise<{ record: ArtifactRecord } | { error: string }> {
  const action = normalizeString(raw.action) ?? "create";
  if (action === "revise") { const artifactId = normalizeString(raw.artifact_id); if (!artifactId) return { error: "revise 操作需要 artifact_id" }; return { record: await artifacts.reviseArtifact({ artifactId, configPatch: toJsonValue(raw.config ?? {}), replace: raw.replace === true }) }; }
  if (action !== "create") return { error: `不支持的 artifact action: ${action}` };
  if (!sessionId) return { error: "创建 artifact 需要 session_id" };
  const vizType = normalizeString(raw.viz_type); if (!vizType) return { error: "artifact 需要 viz_type" };
  const asset = decodeAsset(raw.asset); if ("error" in asset) return asset;
  if ((raw.config === undefined || raw.config === null) && !asset.value) return { error: "artifact 至少需要 config 或 asset" };
  return { record: await artifacts.createArtifact({ sessionId, vizType, subType: normalizeString(raw.sub_type), title: normalizeString(raw.title), config: raw.config == null ? {} : toJsonValue(raw.config), asset: asset.value }) };
}

function decodeAsset(value: unknown): { value: ArtifactAssetInput | null } | { error: string } {
  if (value == null) return { value: null };
  if (!isRecord(value)) return { error: "artifact.asset 必须是对象" };
  const data = normalizeString(value.data_base64); const mimeType = normalizeString(value.mime_type);
  if (!data || !mimeType) return { error: "artifact.asset 需要 data_base64 和 mime_type" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0) return { error: "artifact.asset.data_base64 格式无效" };
  const body = Buffer.from(data, "base64"); if (!body.byteLength) return { error: "artifact.asset 内容不能为空" }; if (body.byteLength > MAX_EMBEDDED_ASSET_BYTES) return { error: `artifact.asset 不能超过 ${MAX_EMBEDDED_ASSET_BYTES} 字节` };
  return { value: { body, mimeType, filename: normalizeString(value.filename) } };
}
function replace(result: ToolExecutionResult, content: Record<string, unknown>, metadata: Record<string, unknown>): ToolExecutionResult { return { ...result, content, metadata }; }
function normalizeString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function toJsonValue(value: unknown): JsonValue { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value; if (Array.isArray(value)) return value.map(toJsonValue); if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)])); return null; }
