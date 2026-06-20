import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentConfig } from "../../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../../contracts/model-adapter.js";
import type { RuntimeToolExecutionContext, ToolExecutionResult } from "../../../runtime/runtime-tool-types.js";

const GEOJSON_TYPES = new Set([
  "FeatureCollection",
  "Feature",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);
const SKILLS_DOC_TOOL_NAMES = new Set(["activate_skill", "load_skill_resource", "get_skill_info"]);
const SOURCE_READ_TOOL_NAMES = new Set(["read_file"]);

interface ObservationDecision {
  mode: "inline" | "artifact_ref";
  reason: string;
  estimatedSize: number;
  artifactTtlSeconds: number | null;
  budgetBucket: string;
}

interface ObservationBudget {
  bucketName: string;
  inlineTextLimit: number;
  inlineJsonLimit: number;
  artifactTtlSeconds: number;
}

interface ObservationArtifactRef {
  artifact_type: "json" | "text";
  path: string;
  mime_type: "application/json" | "text/plain";
  size: number;
  metadata: Record<string, unknown>;
}

export async function buildLlmFacingToolResult(input: {
  toolContext: RuntimeToolExecutionContext;
  toolName: string;
  result: ToolExecutionResult;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  dataRoot: string;
}): Promise<ToolExecutionResult> {
  const decision = decideObservation(input.result, {
    toolName: input.toolName,
    agent: input.agent,
    provider: input.provider,
  });
  if (decision.mode === "inline") {
    return input.result;
  }

  if (isSourceReadResult(input.result, input.toolName)) {
    return makeObservationOnlyToolResult(input.result, formatSourceReadReference(input.result));
  }

  const sessionId = asNonEmptyString(input.toolContext.sessionId);
  if (!sessionId) {
    return input.result;
  }

  try {
    const artifact = await saveObservationArtifact({
      dataRoot: input.dataRoot,
      sessionId,
      toolName: input.result.tool_name || input.toolName,
      content: input.result.content,
      decision,
    });
    input.result.artifacts.push(artifact);
    return makeObservationOnlyToolResult(
      input.result,
      renderLargePayloadReference({
        result: input.result,
        artifact,
        estimatedSize: decision.estimatedSize,
      }),
    );
  } catch {
    return input.result;
  }
}

function decideObservation(
  result: ToolExecutionResult,
  input: {
    toolName: string;
    agent: AgentConfig;
    provider: ModelProviderConfig;
  },
): ObservationDecision {
  const estimatedSize = estimateObservationSize(result.content);
  const budget = resolveObservationBudget(input.agent, input.provider);
  const metadata = result.metadata ?? {};

  if (metadata.force_artifact === true) {
    return {
      mode: "artifact_ref",
      reason: "force_artifact",
      estimatedSize,
      artifactTtlSeconds: budget.artifactTtlSeconds,
      budgetBucket: budget.bucketName,
    };
  }

  if (!result.success) {
    return {
      mode: "inline",
      reason: "error_inline",
      estimatedSize,
      artifactTtlSeconds: null,
      budgetBucket: budget.bucketName,
    };
  }

  const outputType = result.output_type.toLowerCase();
  if (outputType === "chart" || outputType === "map") {
    return {
      mode: "inline",
      reason: "visualization_inline",
      estimatedSize,
      artifactTtlSeconds: null,
      budgetBucket: budget.bucketName,
    };
  }

  const effectiveToolName = result.tool_name || input.toolName;
  if (SKILLS_DOC_TOOL_NAMES.has(effectiveToolName)) {
    return {
      mode: "inline",
      reason: "skills_inline",
      estimatedSize,
      artifactTtlSeconds: null,
      budgetBucket: budget.bucketName,
    };
  }

  if (effectiveToolName === "read_file") {
    return {
      mode: "inline",
      reason: result.metadata.user_approved_full_read ? "user_approved_read" : "read_file_inline",
      estimatedSize,
      artifactTtlSeconds: null,
      budgetBucket: budget.bucketName,
    };
  }

  const inlineLimit = inlineLimitForObservation(result, budget);
  return {
    mode: estimatedSize <= inlineLimit ? "inline" : "artifact_ref",
    reason: estimatedSize <= inlineLimit ? "size_inline" : "large_payload",
    estimatedSize,
    artifactTtlSeconds: estimatedSize <= inlineLimit ? null : budget.artifactTtlSeconds,
    budgetBucket: budget.bucketName,
  };
}

function resolveObservationBudget(agent: AgentConfig, provider: ModelProviderConfig): ObservationBudget {
  const behavior = isRecord(agent.custom_params?.behavior) ? agent.custom_params.behavior : {};
  const maxContextTokens =
    positiveInt(behavior.max_context_tokens) ??
    positiveInt(provider.max_context_tokens) ??
    positiveInt(agent.llm_tiers?.default?.max_context_tokens) ??
    128000;
  const budgetProfile = asNonEmptyString(behavior.budget_profile) ?? "worker";
  let budget: ObservationBudget;
  if (maxContextTokens <= 8000) {
    budget = {
      bucketName: "compact",
      inlineTextLimit: 800,
      inlineJsonLimit: 1200,
      artifactTtlSeconds: 6 * 60 * 60,
    };
  } else if (maxContextTokens <= 32000) {
    budget = {
      bucketName: "balanced",
      inlineTextLimit: 1600,
      inlineJsonLimit: 2400,
      artifactTtlSeconds: 12 * 60 * 60,
    };
  } else {
    budget = {
      bucketName: "expansive",
      inlineTextLimit: 2600,
      inlineJsonLimit: 3600,
      artifactTtlSeconds: 24 * 60 * 60,
    };
  }

  if (budgetProfile === "orchestrator") {
    return {
      bucketName: budget.bucketName,
      inlineTextLimit: Math.floor(budget.inlineTextLimit * 0.85),
      inlineJsonLimit: Math.floor(budget.inlineJsonLimit * 0.85),
      artifactTtlSeconds: Math.max(2 * 60 * 60, Math.floor(budget.artifactTtlSeconds * 0.75)),
    };
  }
  return budget;
}

function inlineLimitForObservation(result: ToolExecutionResult, budget: ObservationBudget): number {
  if (result.output_type === "text" || typeof result.content === "string") {
    return budget.inlineTextLimit;
  }
  if (isRecord(result.content) && isGeoJsonLike(result.content)) {
    return Math.floor(budget.inlineJsonLimit * 0.4);
  }
  return budget.inlineJsonLimit;
}

function makeObservationOnlyToolResult(result: ToolExecutionResult, observation: string): ToolExecutionResult<string> {
  return {
    ...result,
    summary: "",
    answer: null,
    output_type: "text",
    content: observation,
    metadata: preserveObservationMetadata(result.metadata),
  };
}

function preserveObservationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const semantic = asNonEmptyString(metadata.semantic);
  return semantic ? { semantic } : {};
}

async function saveObservationArtifact(input: {
  dataRoot: string;
  sessionId: string;
  toolName: string;
  content: unknown;
  decision: ObservationDecision;
}): Promise<ObservationArtifactRef> {
  const isText = typeof input.content === "string";
  const root = path.join(input.dataRoot, "sessions", input.sessionId, "transient");
  await fs.promises.mkdir(root, { recursive: true });
  const fileName = `data_${randomUUID().replace(/-/g, "").slice(0, 8)}${isText ? ".txt" : ".json"}`;
  const filePath = path.join(root, fileName);
  await fs.promises.writeFile(
    filePath,
    isText ? (input.content as string) : stringifyJsonForArtifact(input.content),
    "utf8",
  );
  const stat = await fs.promises.stat(filePath);
  const createdAt = Date.now() / 1000;
  const metadata: Record<string, unknown> = {
    session_id: input.sessionId,
    tool_name: input.toolName,
    created_at: createdAt,
    reason: input.decision.reason,
    estimated_size: input.decision.estimatedSize,
    budget_bucket: input.decision.budgetBucket,
  };
  if (input.decision.artifactTtlSeconds !== null) {
    metadata.expires_at = createdAt + input.decision.artifactTtlSeconds;
  }
  const artifact: ObservationArtifactRef = {
    artifact_type: isText ? "text" : "json",
    path: filePath,
    mime_type: isText ? "text/plain" : "application/json",
    size: stat.size,
    metadata,
  };
  await appendArtifactIndexRecord(root, {
    artifact,
    toolName: input.toolName,
    sessionId: input.sessionId,
    createdAt,
  });
  return artifact;
}

async function appendArtifactIndexRecord(
  root: string,
  input: {
    artifact: ObservationArtifactRef;
    toolName: string;
    sessionId: string;
    createdAt: number;
  },
): Promise<void> {
  const record: Record<string, unknown> = {
    artifact_type: input.artifact.artifact_type,
    path: input.artifact.path,
    tool_name: input.toolName,
    session_id: input.sessionId,
    created_at: input.createdAt,
    mime_type: input.artifact.mime_type,
    size: input.artifact.size,
    metadata: stripArtifactIndexMetadata(input.artifact.metadata),
  };
  if (typeof input.artifact.metadata.expires_at === "number") {
    record.expires_at = input.artifact.metadata.expires_at;
  }
  await fs.promises.appendFile(path.join(root, "artifact_index.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

function stripArtifactIndexMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "session_id" || key === "tool_name" || key === "created_at" || key === "expires_at") {
      continue;
    }
    stripped[key] = value;
  }
  return stripped;
}

function renderLargePayloadReference(input: {
  result: ToolExecutionResult;
  artifact: ObservationArtifactRef;
  estimatedSize: number;
}): string {
  const metadata = input.result.metadata ?? {};
  const parts: string[] = [];
  const answer = asNonEmptyString(input.result.answer);
  const approvalMessage = asNonEmptyString(metadata.approval_message);
  if (answer) {
    parts.push(`${answer}\n`);
  }
  if (approvalMessage) {
    parts.push(`用户批注: ${approvalMessage}\n`);
  }

  parts.push(`数据已存储: ${input.artifact.path}`);
  parts.push(renderLargePayloadMetaInfo(input.result, input.estimatedSize));
  parts.push("后续工具可直接使用此文件路径作为 data 参数；需要处理数据时用 execute_code 读取此文件");

  if (metadata.sample !== undefined) {
    parts.push(`样本: ${stringifyJsonCompact(metadata.sample)}`);
  }
  const preview = buildStructuredPreview(input.result.content);
  if (preview) {
    parts.push(preview);
  }
  return parts.join("\n");
}

function renderLargePayloadMetaInfo(result: ToolExecutionResult, estimatedSize: number): string {
  const metadata = result.metadata ?? {};
  const parts: string[] = [];
  if (result.summary) {
    parts.push(result.summary);
  }
  const totalCount = metadata.total_count;
  if (totalCount) {
    const dataType = asNonEmptyString(metadata.data_type) ?? "List";
    parts.push(`${dataType}: ${String(totalCount)} 条记录`);
  }
  const fieldNames = extractFieldNames(metadata.fields);
  if (fieldNames) {
    parts.push(fieldNames);
  }
  if (parts.length === 0 && estimatedSize > 0) {
    parts.push(`数据量过大 | 估算大小: ${estimatedSize}`);
  }
  return parts.length ? parts.join(" | ") : "数据量过大";
}

function extractFieldNames(fields: unknown): string | null {
  if (!Array.isArray(fields) || fields.length === 0) {
    return null;
  }
  const names = fields
    .slice(0, 5)
    .map((field) => isRecord(field) ? asNonEmptyString(field.name) : null)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) {
    return null;
  }
  const suffix = fields.length > 5 ? ` 等 ${fields.length} 个字段` : "";
  return `字段: ${names.join(", ")}${suffix}`;
}

function formatSourceReadReference(result: ToolExecutionResult): string {
  const metadata = result.metadata ?? {};
  const filePath = asNonEmptyString(metadata.file_path) ?? "";
  const content = typeof result.content === "string" ? result.content : String(result.content);
  let preview = content.slice(0, 500);
  if (content.length > 500) {
    preview = `${preview.trimEnd()}...`;
  }

  const parts: string[] = [];
  const answer = asNonEmptyString(result.answer);
  const approvalMessage = asNonEmptyString(metadata.approval_message);
  if (answer) {
    parts.push(`${answer}\n`);
  } else if (result.summary) {
    parts.push(`${result.summary}\n`);
  }
  if (approvalMessage) {
    parts.push(`用户批注: ${approvalMessage}\n`);
  }
  parts.push(`原始文件: ${filePath}`);
  const startLine = metadata.start_line;
  const endLine = metadata.end_line;
  if (startLine !== undefined && endLine !== undefined) {
    parts.push(`当前片段: 行 ${String(startLine)}-${String(endLine)}`);
  }
  if (metadata.has_more) {
    parts.push(`如需后续内容，请继续调用 read_file(file_path='${filePath}', offset=${String(metadata.next_offset)})`);
  }
  if (preview) {
    parts.push(`预览: ${preview}`);
  }
  return parts.join("\n");
}

function isSourceReadResult(result: ToolExecutionResult, toolName: string): boolean {
  const effectiveToolName = result.tool_name || toolName;
  return SOURCE_READ_TOOL_NAMES.has(effectiveToolName) && Boolean(asNonEmptyString(result.metadata?.file_path));
}

function buildStructuredPreview(content: unknown): string | null {
  if (!isRecord(content) && !Array.isArray(content)) {
    return null;
  }
  const preview = isRecord(content) && isGeoJsonLike(content)
    ? removeGeoJsonCoordinates(content)
    : previewDataValue(content, 2);
  const label = isRecord(content) && isGeoJsonLike(content) ? "GeoJSON 预览" : "数据结构";
  let previewText = stringifyJsonPretty(preview);
  if (previewText.length > 1500) {
    previewText = `${previewText.slice(0, 1500)}\n  ...`;
  }
  return `${label}:\n\`\`\`json\n${previewText}\n\`\`\``;
}

function previewDataValue(value: unknown, depth: number): unknown {
  if (depth <= 0) {
    return summarizePreviewLeaf(value);
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 3).map((item) => previewDataValue(item, depth - 1)),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const preview: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, 10)) {
      preview[key] = previewDataValue(item, depth - 1);
    }
    if (entries.length > 10) {
      preview.__truncated_keys__ = entries.length - 10;
    }
    return preview;
  }
  return value;
}

function summarizePreviewLeaf(value: unknown): unknown {
  if (typeof value === "string" && value.length > 160) {
    return `${value.slice(0, 160)}...`;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (isRecord(value)) {
    return { type: "object", keys: Object.keys(value).slice(0, 10) };
  }
  return value;
}

function removeGeoJsonCoordinates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 3).map((item) => removeGeoJsonCoordinates(item));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "coordinates") {
        output[key] = "[omitted]";
      } else {
        output[key] = removeGeoJsonCoordinates(item);
      }
    }
    return output;
  }
  return value;
}

function estimateObservationSize(data: unknown): number {
  if (typeof data === "string") {
    return data.length;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return 2;
    }
    if (data.length <= 10) {
      return jsonLength(data);
    }
    const sample = data.slice(0, 10);
    return Math.floor(jsonLength(sample) * (data.length / sample.length));
  }
  if (isRecord(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return 2;
    }
    if (entries.length <= 10) {
      return jsonLength(data);
    }
    const sample = Object.fromEntries(entries.slice(0, 10));
    return Math.floor(jsonLength(sample) * (entries.length / 10));
  }
  return String(data).length;
}

function isGeoJsonLike(data: Record<string, unknown>): boolean {
  return typeof data.type === "string" && GEOJSON_TYPES.has(data.type);
}

function stringifyJsonForArtifact(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? String(value) : rendered;
}

function stringifyJsonPretty(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? String(value) : rendered;
}

function stringifyJsonCompact(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function jsonLength(value: unknown): number {
  return stringifyJsonCompact(value).length;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
