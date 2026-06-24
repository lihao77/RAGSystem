/**
 * Observation 渲染 + 大 payload 落盘（迁自 backend-ts observation.ts + rendering.ts 的 tool-result 部分）。
 *
 * 工具执行的"O"：把 ToolExecutionResult 变成回喂给模型的 observation 文本。
 * 两层职责：
 * - buildLlmFacingToolResult：大 payload 决策——超过 inline 预算的 content 物化成 artifact 文件，
 *   落到 dataRoot/sessions/<sid>/transient/，结果替换成文件路径引用（供后续工具 {result_N} 复用）。
 * - renderToolResultContent：把最终结果包进 <tool_result> 语义块（execute_bash/request_user_input 等特判）。
 *
 * 与 backend-ts 差异：
 * - agent: AgentConfig → profile: AgentProfile；maxContextTokens 从 profile.llmTiers.default 取（已决值）。
 * - budget_profile 从 profile.customParams 取。
 * - result 字段 snake_case → camelCase（toolName/outputType/llmHint）。
 * - metadata record 的 key 保持 snake_case（数据契约，消费端产出原样）。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProviderConfig } from "@ragsystem/agent-llm";
import type { ToolArtifact, ToolExecutionResult, ToolExecContext } from "../contracts.js";
import type { AgentProfile } from "../types.js";
import { renderSemanticBlock } from "../protocol/xml/rendering.js";

const GEOJSON_TYPES = new Set(["FeatureCollection", "Feature", "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]);
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

export async function buildLlmFacingToolResult(input: {
  toolContext: ToolExecContext;
  toolName: string;
  result: ToolExecutionResult;
  profile: AgentProfile;
  provider: ProviderConfig;
  dataRoot: string;
}): Promise<ToolExecutionResult> {
  const decision = decideObservation(input.result, { toolName: input.toolName, profile: input.profile, provider: input.provider });
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
      toolName: input.result.toolName || input.toolName,
      content: input.result.content,
      decision,
    });
    input.result.artifacts.push(artifact);
    return makeObservationOnlyToolResult(input.result, renderLargePayloadReference({ result: input.result, artifact, estimatedSize: decision.estimatedSize }));
  } catch {
    return input.result;
  }
}

/* ============================================================
 * 大 payload 决策 + 落盘
 * ========================================================== */

function decideObservation(result: ToolExecutionResult, input: { toolName: string; profile: AgentProfile; provider: ProviderConfig }): ObservationDecision {
  const estimatedSize = estimateObservationSize(result.content);
  const budget = resolveObservationBudget(input.profile, input.provider);
  const metadata = result.metadata ?? {};

  if (metadata.force_artifact === true) {
    return { mode: "artifact_ref", reason: "force_artifact", estimatedSize, artifactTtlSeconds: budget.artifactTtlSeconds, budgetBucket: budget.bucketName };
  }
  if (!result.success) {
    return { mode: "inline", reason: "error_inline", estimatedSize, artifactTtlSeconds: null, budgetBucket: budget.bucketName };
  }
  const outputType = result.outputType.toLowerCase();
  if (outputType === "chart" || outputType === "map") {
    return { mode: "inline", reason: "visualization_inline", estimatedSize, artifactTtlSeconds: null, budgetBucket: budget.bucketName };
  }
  const effectiveToolName = result.toolName || input.toolName;
  if (SKILLS_DOC_TOOL_NAMES.has(effectiveToolName)) {
    return { mode: "inline", reason: "skills_inline", estimatedSize, artifactTtlSeconds: null, budgetBucket: budget.bucketName };
  }
  if (effectiveToolName === "read_file") {
    return { mode: "inline", reason: result.metadata.user_approved_full_read ? "user_approved_read" : "read_file_inline", estimatedSize, artifactTtlSeconds: null, budgetBucket: budget.bucketName };
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

function resolveObservationBudget(profile: AgentProfile, _provider: ProviderConfig): ObservationBudget {
  const maxContextTokens = profile.llmTiers.default?.maxContextTokens ?? 128000;
  const budgetProfile = asNonEmptyString(profile.customParams?.budget_profile) ?? "worker";
  let budget: ObservationBudget;
  if (maxContextTokens <= 8000) {
    budget = { bucketName: "compact", inlineTextLimit: 800, inlineJsonLimit: 1200, artifactTtlSeconds: 6 * 60 * 60 };
  } else if (maxContextTokens <= 32000) {
    budget = { bucketName: "balanced", inlineTextLimit: 1600, inlineJsonLimit: 2400, artifactTtlSeconds: 12 * 60 * 60 };
  } else {
    budget = { bucketName: "expansive", inlineTextLimit: 2600, inlineJsonLimit: 3600, artifactTtlSeconds: 24 * 60 * 60 };
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
  if (result.outputType === "text" || typeof result.content === "string") {
    return budget.inlineTextLimit;
  }
  if (isRecord(result.content) && isGeoJsonLike(result.content)) {
    return Math.floor(budget.inlineJsonLimit * 0.4);
  }
  return budget.inlineJsonLimit;
}

function makeObservationOnlyToolResult(result: ToolExecutionResult, observation: string): ToolExecutionResult {
  return {
    ...result,
    summary: "",
    answer: null,
    outputType: "text",
    content: observation,
    metadata: preserveObservationMetadata(result.metadata),
  };
}

function preserveObservationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const semantic = asNonEmptyString(metadata.semantic);
  return semantic ? { semantic } : {};
}

async function saveObservationArtifact(input: { dataRoot: string; sessionId: string; toolName: string; content: unknown; decision: ObservationDecision }): Promise<ToolArtifact> {
  const isText = typeof input.content === "string";
  const root = path.join(input.dataRoot, "sessions", input.sessionId, "transient");
  await fs.promises.mkdir(root, { recursive: true });
  const fileName = `data_${randomUUID().replace(/-/g, "").slice(0, 8)}${isText ? ".txt" : ".json"}`;
  const filePath = path.join(root, fileName);
  await fs.promises.writeFile(filePath, isText ? (input.content as string) : stringifyJsonForArtifact(input.content), "utf8");
  const stat = await fs.promises.stat(filePath);
  const createdAt = Date.now() / 1000;
  const metadata: Record<string, unknown> = { session_id: input.sessionId, tool_name: input.toolName, created_at: createdAt, reason: input.decision.reason, estimated_size: input.decision.estimatedSize, budget_bucket: input.decision.budgetBucket };
  if (input.decision.artifactTtlSeconds !== null) {
    metadata.expires_at = createdAt + input.decision.artifactTtlSeconds;
  }
  const artifact: ToolArtifact = { artifactType: isText ? "text" : "json", path: filePath, mimeType: isText ? "text/plain" : "application/json", size: stat.size, metadata };
  await appendArtifactIndexRecord(root, { artifact, toolName: input.toolName, sessionId: input.sessionId, createdAt });
  return artifact;
}

async function appendArtifactIndexRecord(root: string, input: { artifact: ToolArtifact; toolName: string; sessionId: string; createdAt: number }): Promise<void> {
  const record: Record<string, unknown> = { artifact_type: input.artifact.artifactType, path: input.artifact.path, tool_name: input.toolName, session_id: input.sessionId, created_at: input.createdAt, mime_type: input.artifact.mimeType, size: input.artifact.size, metadata: stripArtifactIndexMetadata(input.artifact.metadata) };
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

function renderLargePayloadReference(input: { result: ToolExecutionResult; artifact: ToolArtifact; estimatedSize: number }): string {
  const metadata = input.result.metadata ?? {};
  const parts: string[] = [];
  const answer = asNonEmptyString(input.result.answer);
  const approvalMessage = asNonEmptyString(metadata.approval_message);
  if (answer) { parts.push(`${answer}\n`); }
  if (approvalMessage) { parts.push(`用户批注: ${approvalMessage}\n`); }
  parts.push(`数据已存储: ${input.artifact.path}`);
  parts.push(renderLargePayloadMetaInfo(input.result, input.estimatedSize));
  parts.push("后续工具可直接使用此文件路径作为 data 参数；需要处理数据时用 execute_code 读取此文件");
  if (metadata.sample !== undefined) { parts.push(`样本: ${stringifyJsonCompact(metadata.sample)}`); }
  const preview = buildStructuredPreview(input.result.content);
  if (preview) { parts.push(preview); }
  return parts.join("\n");
}

function renderLargePayloadMetaInfo(result: ToolExecutionResult, estimatedSize: number): string {
  const metadata = result.metadata ?? {};
  const parts: string[] = [];
  if (result.summary) { parts.push(result.summary); }
  const totalCount = metadata.total_count;
  if (totalCount) {
    const dataType = asNonEmptyString(metadata.data_type) ?? "List";
    parts.push(`${dataType}: ${String(totalCount)} 条记录`);
  }
  const fieldNames = extractFieldNames(metadata.fields);
  if (fieldNames) { parts.push(fieldNames); }
  if (parts.length === 0 && estimatedSize > 0) { parts.push(`数据量过大 | 估算大小: ${estimatedSize}`); }
  return parts.length ? parts.join(" | ") : "数据量过大";
}

function extractFieldNames(fields: unknown): string | null {
  if (!Array.isArray(fields) || fields.length === 0) { return null; }
  const names = fields.slice(0, 5).map((field) => (isRecord(field) ? asNonEmptyString(field.name) : null)).filter((name): name is string => Boolean(name));
  if (names.length === 0) { return null; }
  const suffix = fields.length > 5 ? ` 等 ${fields.length} 个字段` : "";
  return `字段: ${names.join(", ")}${suffix}`;
}

function formatSourceReadReference(result: ToolExecutionResult): string {
  const metadata = result.metadata ?? {};
  const filePath = asNonEmptyString(metadata.file_path) ?? "";
  const content = typeof result.content === "string" ? result.content : String(result.content);
  let preview = content.slice(0, 500);
  if (content.length > 500) { preview = `${preview.trimEnd()}...`; }
  const parts: string[] = [];
  const answer = asNonEmptyString(result.answer);
  const approvalMessage = asNonEmptyString(metadata.approval_message);
  if (answer) { parts.push(`${answer}\n`); } else if (result.summary) { parts.push(`${result.summary}\n`); }
  if (approvalMessage) { parts.push(`用户批注: ${approvalMessage}\n`); }
  parts.push(`原始文件: ${filePath}`);
  const startLine = metadata.start_line;
  const endLine = metadata.end_line;
  if (startLine !== undefined && endLine !== undefined) { parts.push(`当前片段: 行 ${String(startLine)}-${String(endLine)}`); }
  if (metadata.has_more) { parts.push(`如需后续内容，请继续调用 read_file(file_path='${filePath}', offset=${String(metadata.next_offset)})`); }
  if (preview) { parts.push(`预览: ${preview}`); }
  return parts.join("\n");
}

function isSourceReadResult(result: ToolExecutionResult, toolName: string): boolean {
  const effectiveToolName = result.toolName || toolName;
  return SOURCE_READ_TOOL_NAMES.has(effectiveToolName) && Boolean(asNonEmptyString(result.metadata?.file_path));
}

function buildStructuredPreview(content: unknown): string | null {
  if (!isRecord(content) && !Array.isArray(content)) { return null; }
  const preview = isRecord(content) && isGeoJsonLike(content) ? removeGeoJsonCoordinates(content) : previewDataValue(content, 2);
  const label = isRecord(content) && isGeoJsonLike(content) ? "GeoJSON 预览" : "数据结构";
  let previewText = stringifyJsonPretty(preview);
  if (previewText.length > 1500) { previewText = `${previewText.slice(0, 1500)}\n  ...`; }
  return `${label}:\n\`\`\`json\n${previewText}\n\`\`\``;
}

function previewDataValue(value: unknown, depth: number): unknown {
  if (depth <= 0) { return summarizePreviewLeaf(value); }
  if (Array.isArray(value)) { return { type: "array", length: value.length, sample: value.slice(0, 3).map((item) => previewDataValue(item, depth - 1)) }; }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const preview: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, 10)) { preview[key] = previewDataValue(item, depth - 1); }
    if (entries.length > 10) { preview.__truncated_keys__ = entries.length - 10; }
    return preview;
  }
  return value;
}

function summarizePreviewLeaf(value: unknown): unknown {
  if (typeof value === "string" && value.length > 160) { return `${value.slice(0, 160)}...`; }
  if (Array.isArray(value)) { return { type: "array", length: value.length }; }
  if (isRecord(value)) { return { type: "object", keys: Object.keys(value).slice(0, 10) }; }
  return value;
}

function removeGeoJsonCoordinates(value: unknown): unknown {
  if (Array.isArray(value)) { return value.slice(0, 3).map((item) => removeGeoJsonCoordinates(item)); }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) { output[key] = key === "coordinates" ? "[omitted]" : removeGeoJsonCoordinates(item); }
    return output;
  }
  return value;
}

function estimateObservationSize(data: unknown): number {
  if (typeof data === "string") { return data.length; }
  if (Array.isArray(data)) {
    if (data.length === 0) { return 2; }
    if (data.length <= 10) { return jsonLength(data); }
    const sample = data.slice(0, 10);
    return Math.floor(jsonLength(sample) * (data.length / sample.length));
  }
  if (isRecord(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) { return 2; }
    if (entries.length <= 10) { return jsonLength(data); }
    const sample = Object.fromEntries(entries.slice(0, 10));
    return Math.floor(jsonLength(sample) * (entries.length / 10));
  }
  return String(data).length;
}

function isGeoJsonLike(data: Record<string, unknown>): boolean {
  return typeof data.type === "string" && GEOJSON_TYPES.has(data.type);
}

/* ============================================================
 * tool-result observation 文本渲染（迁自 backend-ts rendering.ts）
 * ========================================================== */

export function renderToolResultContent(input: { callId: string; toolName: string; result: ToolExecutionResult }): string {
  const semantic = inferToolResultSemantic(input.toolName, input.result);
  return renderSemanticBlock("tool_result", renderCompactToolObservation(input.result, input.toolName), {
    id: input.callId,
    name: input.toolName,
    ok: input.result.success ? "true" : "false",
    ...(semantic ? { semantic } : {}),
  });
}

function renderCompactToolObservation(result: ToolExecutionResult, toolName: string): string {
  if (!result.success) {
    return `[ERROR] ${stringifyToolContent(result.content) || "未知错误"}`;
  }
  if (result.toolName === "request_user_input" && typeof result.content === "string") {
    return appendLlmHint(result.content, result);
  }
  if ((result.toolName || toolName) === "execute_bash") {
    return appendLlmHint(renderBashToolObservation(result), result);
  }
  const renderedContent = renderToolContentForObservation(result.content, result.outputType);
  let observation = renderObservationPrefix(result);
  if (renderedContent) {
    if (observation && !(result.summary && renderedContent.trim() === result.summary.trim())) {
      observation += `\n\n${renderedContent}`;
    } else if (!observation) {
      observation = renderedContent;
    }
  }
  return appendLlmHint(observation || result.summary, result);
}

function inferToolResultSemantic(toolName: string, result: ToolExecutionResult): string | null {
  const semantic = result.metadata.semantic;
  if (typeof semantic === "string" && semantic.trim()) { return semantic.trim(); }
  return toolName === "request_user_input" ? "user_input_response" : null;
}

function renderObservationPrefix(result: ToolExecutionResult): string {
  let prefix = "";
  const answer = typeof result.answer === "string" && result.answer.trim() ? result.answer.trim() : null;
  if (answer) { prefix += answer; } else if (result.summary) { prefix += result.summary; }
  const metadataPrefix = renderMetadataObservationPrefix(result);
  if (metadataPrefix) { prefix += prefix ? `\n\n${metadataPrefix}` : metadataPrefix; }
  return prefix;
}

function renderMetadataObservationPrefix(result: ToolExecutionResult): string {
  const childAgentId = typeof result.metadata.child_agent_id === "string" && result.metadata.child_agent_id.trim() ? result.metadata.child_agent_id.trim() : null;
  const approvalMessage = typeof result.metadata.approval_message === "string" && result.metadata.approval_message.trim() ? result.metadata.approval_message.trim() : null;
  const parts: string[] = [];
  if (childAgentId) { parts.push(`child_agent_id: ${childAgentId}`); }
  if (approvalMessage) { parts.push(`用户批注: ${approvalMessage}`); }
  return parts.join("\n\n");
}

function renderBashToolObservation(result: ToolExecutionResult): string {
  const content = result.content;
  const summary = result.summary || "";
  if (!isRecord(content)) {
    const rendered = stringifyToolContent(content);
    return summary ? `${summary}\n${rendered}` : rendered;
  }
  const stdout = typeof content.stdout === "string" ? content.stdout : "";
  const stderr = typeof content.stderr === "string" ? content.stderr : "";
  const returnCode = typeof content.return_code === "number" ? content.return_code : null;
  const interrupted = content.interrupted === true;
  const backgroundTaskId = typeof content.background_task_id === "string" && content.background_task_id.trim() ? content.background_task_id.trim() : null;
  if (backgroundTaskId) {
    const parts = ["后台任务已启动", `task_id: ${backgroundTaskId}`];
    if (summary) { parts.unshift(summary); }
    return parts.join("\n");
  }
  const parts: string[] = [];
  if (summary) { parts.push(summary); }
  if (interrupted) {
    if (stdout) { parts.push(stdout); }
    if (stderr) { parts.push(`[stderr]\n${stderr}`); }
    return parts.join("\n");
  }
  if (returnCode !== null && returnCode !== undefined && returnCode !== 0) {
    if (stderr) { parts.push(`[stderr]\n${stderr}`); }
    if (stdout) { parts.push(`[stdout]\n${stdout}`); }
    return parts.join("\n");
  }
  if (stdout) { parts.push(stdout); }
  if (stderr) { parts.push(`[stderr]\n${stderr}`); }
  return parts.length ? parts.join("\n") : summary || "命令执行完成";
}

function renderToolContentForObservation(content: unknown, outputType: string): string {
  if (content === null || content === undefined) { return ""; }
  if (typeof content === "string") { return content; }
  if (outputType === "json" || Array.isArray(content) || isRecord(content)) { return `\`\`\`json\n${stringifyJsonForObservation(content)}\n\`\`\``; }
  return stringifyToolContent(content);
}

function appendLlmHint(observation: string, result: ToolExecutionResult): string {
  const hint = typeof result.llmHint === "string" && result.llmHint.trim() ? result.llmHint.trim() : null;
  if (!hint) { return observation; }
  return observation ? `${observation}\n${hint}` : hint;
}

function stringifyJsonForObservation(content: unknown): string {
  try { return JSON.stringify(content, null, 2); } catch { return stringifyToolContent(content); }
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

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") { return content; }
  if (content === null || content === undefined) { return ""; }
  try { return JSON.stringify(content); } catch { return String(content); }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
