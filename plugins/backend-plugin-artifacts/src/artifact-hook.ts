import type { ToolAfterInput, ToolAfterOutput, ToolExecutionResult } from "@ragsystem/agent-sdk";

import type { ArtifactsPluginDependencies } from "./dependencies.js";
import type { ArtifactApplication, ArtifactRecord } from "./contracts/artifact-application.js";
import type { JsonValue } from "./contracts/json.js";

export function createArtifactToolAfterHook(
  dependencies: Pick<ArtifactsPluginDependencies, "storage">,
): (input: ToolAfterInput) => Promise<ToolAfterOutput | void> {
  return async ({ toolName, result, ctx }) => {
    if (toolName !== "execute_skill_script" || !result.success || !isRecord(result.content) || !("artifact" in result.content)) {
      return;
    }

    const { artifact: rawArtifact, ...content } = result.content;
    const fail = (message: string): ToolAfterOutput => ({
      modifiedResult: replaceArtifactContent(result, content, {
        ...result.metadata,
        artifact_error: message,
      }),
    });
    if (!isRecord(rawArtifact)) return fail("artifact 字段必须是对象");

    const tenantId = normalizeString(ctx.tenantId);
    if (!tenantId) return fail("Artifact 插件需要 tenant_id");
    try {
      const artifacts = await dependencies.storage.applicationForTenant(tenantId);
      const persisted = await persistArtifact(artifacts, rawArtifact, normalizeString(ctx.sessionId));
      if ("error" in persisted) return fail(persisted.error);
      const info = persisted.record;
      return {
        modifiedResult: {
          ...replaceArtifactContent(result, {
            ...content,
            artifact_id: info.artifact_id,
            viz_type: info.viz_type,
          }, {
            ...result.metadata,
            artifact_id: info.artifact_id,
            artifact_persisted: true,
          }),
          outputType: info.viz_type,
          llmHint: `在 <final_answer> 中插入 [viz:${info.artifact_id}] 来展示此可视化`,
        },
      };
    } catch (error) {
      return fail(`artifact 持久化失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

async function persistArtifact(
  artifacts: ArtifactApplication,
  rawArtifact: Record<string, unknown>,
  sessionId: string | null,
): Promise<{ record: ArtifactRecord } | { error: string }> {
  const action = normalizeString(rawArtifact.action) ?? "create";
  if (action === "revise") {
    const artifactId = normalizeString(rawArtifact.artifact_id);
    if (!artifactId) return { error: "revise 操作需要 artifact_id" };
    return {
      record: await artifacts.reviseVisualization({
        artifactId,
        configPatch: toJsonValue(rawArtifact.config ?? {}),
        replace: rawArtifact.replace === true,
      }),
    };
  }
  if (action !== "create") return { error: `不支持的 artifact action: ${action}` };
  if (!sessionId) return { error: "创建 artifact 需要 session_id" };

  const vizType = normalizeString(rawArtifact.viz_type);
  const subType = normalizeString(rawArtifact.sub_type);
  const title = normalizeString(rawArtifact.title) ?? "";
  const config = rawArtifact.config;
  if (!vizType || config === undefined || config === null) {
    return { error: "artifact 需要 viz_type 和 config 字段" };
  }
  if (vizType === "chart") {
    return {
      record: await artifacts.createChart({
        sessionId,
        chartConfig: toJsonValue(config),
        chartType: subType ?? "bar",
        title,
      }),
    };
  }
  if (vizType === "map") {
    return {
      record: await artifacts.createMap({
        sessionId,
        mapData: toJsonValue(config),
        mapType: subType ?? "marker",
        title,
      }),
    };
  }
  return { error: `不支持的 viz_type: ${vizType}` };
}

function replaceArtifactContent(
  result: ToolExecutionResult,
  content: Record<string, unknown>,
  metadata: Record<string, unknown>,
): ToolExecutionResult {
  return { ...result, content, metadata };
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  return null;
}
