/**
 * Observation 渲染 + 大 payload 落盘（迁自 backend-ts observation.ts + rendering.ts 的 tool-result 部分）。
 *
 * 工具执行的"O"：把 ToolExecutionResult 变成回喂给模型的 observation 文本。
 * 三层正交职责（数据/呈现/预算互不干涉）：
 * - 数据面 content：纯结构化数据，经 raw_result 直通 UI、{result_N} 引用与持久化，本层不改写。
 * - 呈现面 outputType：封闭枚举（text/json/markdown/streams/image），本层按类型排版，
 *   不认识任何工具名（streams = 进程执行结果的流式排版，由工具声明）。
 * - 预算面：单一 inline 阈值（现代模型上下文 256k+，不再按上下文分桶、不分 text/json），
 *   超过即物化成临时文件 + 引用文本；force_file / observationPolicy:"inline" 为逃生舱。
 *
 * 与 backend-ts 差异：
 * - result 字段 snake_case → camelCase（toolName/outputType/llmHint）。
 * - metadata record 的 key 保持 snake_case（数据契约，消费端产出原样）。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { ContentPart, ProviderConfig } from "@ragsystem/agent-llm";
import type { ToolFile, ToolExecutionResult, ToolImagePersisted, ToolImageSink, ToolResultMedia } from "../contracts.js";
import type { ObservationPolicy } from "../prompt/tool-types.js";
import { renderSemanticBlock } from "../llm-protocol/xml/rendering.js";

const GEOJSON_TYPES = new Set(["FeatureCollection", "Feature", "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]);
const MAX_TOOL_IMAGES = 4;
const MAX_TOOL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

/* 单一 inline 阈值与物化文件 TTL：不分 text/json、不按模型上下文分桶。
   阈值防的不是"装不下"而是注意力经济（长上下文检索退化）与压缩压力；
   落盘 + 引用是被 Claude Code 验证的模式（其 inline 上限约 30KB 字符）。 */
const INLINE_CHAR_LIMIT = 16_000;
const FILE_TTL_SECONDS = 24 * 60 * 60;

interface ObservationDecision {
  mode: "inline" | "file_ref";
  reason: string;
  estimatedSize: number;
  fileTtlSeconds: number | null;
}

export async function buildLlmFacingToolResult(input: {
  toolName: string;
  result: ToolExecutionResult;
  observationPolicy?: ObservationPolicy;
}): Promise<ToolExecutionResult> {
  const decision = decideObservation(input.result, input.observationPolicy ?? "default");
  if (decision.mode === "inline") {
    return input.result;
  }

  try {
    const file = await saveObservationFile({
      toolName: input.result.toolName || input.toolName,
      content: input.result.content,
      decision,
    });
    input.result.files.push(file);
    return makeObservationOnlyToolResult(input.result, renderLargePayloadReference({ result: input.result, file, estimatedSize: decision.estimatedSize }));
  } catch {
    return input.result;
  }
}

export async function buildToolMediaModelContent(input: {
  result: ToolExecutionResult;
  observation: string;
  provider: ProviderConfig;
  dataRoot: string;
  /** 会话 id：与 imageSink 同时存在时启用会话附件通道。 */
  sessionId?: string | null;
  /** 消费端注入的会话附件持久化端口；未注入或保存失败时回退临时文件通道。 */
  imageSink?: ToolImageSink;
}): Promise<ContentPart[] | null> {
  const media = input.result.media?.slice(0, MAX_TOOL_IMAGES) ?? [];
  if (!media.length) return null;
  const parts: ContentPart[] = [{ type: "text", text: input.observation }];
  const materialized: ToolResultMedia[] = [];
  const persistedFileIds: Array<string | null> = [];
  const rejectedReasons: string[] = [];
  let totalBytes = 0;

  for (const item of media) {
    try {
      const bytes = await readToolImageBytes(item, input.dataRoot);
      if (!bytes) {
        rejectedReasons.push("invalid_or_unreadable_image");
        continue;
      }
      if (bytes.length > MAX_TOOL_IMAGE_BYTES || totalBytes + bytes.length > MAX_TOOL_IMAGE_TOTAL_BYTES) {
        rejectedReasons.push("image_size_limit_exceeded");
        continue;
      }
      totalBytes += bytes.length;
      // 会话附件通道优先：与用户上传同管线（持久、随会话清理、后续轮次投影可归一化）。
      let persisted: ToolImagePersisted | null = null;
      if (input.imageSink && input.sessionId) {
        try {
          persisted = await input.imageSink.save({
            bytes,
            mimeType: item.mimeType,
            toolName: input.result.toolName,
            sessionId: input.sessionId,
            ...(item.alt ? { name: item.alt } : {}),
          });
        } catch {
          persisted = null;
        }
      }
      if (persisted) {
        // files/metadata/materialized 描述 storedPath 上的原始字节（mime 保留入参值）；
        // 只有本轮 in-band data URL 用 sink 的请求适配字节与其 mime（可能换码）。
        input.result.files.push({
          fileType: "image",
          path: persisted.storedPath,
          mimeType: item.mimeType,
          size: persisted.storedSize,
          metadata: {
            tool_name: input.result.toolName,
            created_at: Date.now() / 1000,
            lifecycle: "session",
            file_id: persisted.fileId,
            reason: "observation_media",
          },
        });
        materialized.push({ ...item, source: { type: "file", path: persisted.storedPath } });
        persistedFileIds.push(persisted.fileId);
        if (input.provider.supports_vision === true) {
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${persisted.mimeType};base64,${Buffer.from(persisted.bytes).toString("base64")}`,
              detail: item.detail ?? "auto",
            },
          });
        }
      } else {
        const file = await saveToolImageFile({
          toolName: input.result.toolName,
          mimeType: item.mimeType,
          bytes,
          ttlSeconds: FILE_TTL_SECONDS,
        });
        input.result.files.push(file);
        materialized.push({ ...item, source: { type: "file", path: file.path } });
        persistedFileIds.push(null);
        if (input.provider.supports_vision === true) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${item.mimeType};base64,${bytes.toString("base64")}`, detail: item.detail ?? "auto" },
          });
        }
      }
    } catch {
      rejectedReasons.push("materialization_failed");
    }
  }
  if ((input.result.media?.length ?? 0) > media.length) rejectedReasons.push("image_count_limit_exceeded");
  input.result.media = materialized;
  if (materialized.length) {
    input.result.metadata.tool_result_media = materialized.map((item, index) => ({
      kind: "image",
      stored_path: item.source.type === "file" ? item.source.path : "",
      mime: item.mimeType,
      ...(persistedFileIds[index] ? { file_id: persistedFileIds[index] as string } : {}),
      ...(item.alt ? { original_name: item.alt } : {}),
    }));
  }
  if (rejectedReasons.length) {
    input.result.metadata.tool_result_media_rejected = rejectedReasons.length;
    input.result.metadata.tool_result_media_rejection_reasons = rejectedReasons;
  }
  return parts.length > 1 ? parts : null;
}

async function readToolImageBytes(item: ToolResultMedia, dataRoot: string): Promise<Buffer | null> {
  if (item.source.type === "base64") return decodeBase64(item.source.data, item.mimeType);
  if (item.source.type === "url") return null;
  const filePath = path.resolve(item.source.path);
  if (!isPathUnder(filePath, path.resolve(dataRoot))) return null;
  try {
    const bytes = await fs.promises.readFile(filePath);
    return matchesImageSignature(bytes, item.mimeType) ? bytes : null;
  } catch {
    return null;
  }
}

function decodeBase64(value: string, mimeType: ToolResultMedia["mimeType"]): Buffer | null {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length > Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    const bytes = Buffer.from(normalized, "base64");
    return bytes.length && matchesImageSignature(bytes, mimeType) ? bytes : null;
  } catch {
    return null;
  }
}

function matchesImageSignature(bytes: Buffer, mimeType: ToolResultMedia["mimeType"]): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") return bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a");
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

async function saveToolImageFile(input: {
  toolName: string;
  mimeType: ToolResultMedia["mimeType"];
  bytes: Buffer;
  ttlSeconds: number;
}): Promise<ToolFile> {
  const root = await createObservationTempRoot();
  const filePath = path.join(root, `image_${randomUUID().replace(/-/g, "").slice(0, 8)}${imageExtension(input.mimeType)}`);
  await fs.promises.writeFile(filePath, input.bytes);
  const createdAt = Date.now() / 1000;
  return {
    fileType: "image",
    path: filePath,
    mimeType: input.mimeType,
    size: input.bytes.length,
    metadata: {
      tool_name: input.toolName,
      created_at: createdAt,
      expires_at: createdAt + input.ttlSeconds,
      lifecycle: "transient",
      reason: "observation_media",
    },
  };
}

function imageExtension(mimeType: ToolResultMedia["mimeType"]): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const OBSERVATION_TEMP_DIR_PREFIX = "ragsystem-observation-";

async function createObservationTempRoot(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), OBSERVATION_TEMP_DIR_PREFIX));
}

/* ============================================================
 * 大 payload 决策 + 落盘
 * ========================================================== */

function decideObservation(result: ToolExecutionResult, observationPolicy: ObservationPolicy): ObservationDecision {
  const estimatedSize = estimateObservationSize(result.content);
  const metadata = result.metadata ?? {};

  if (metadata.force_file === true) {
    return { mode: "file_ref", reason: "force_file", estimatedSize, fileTtlSeconds: FILE_TTL_SECONDS };
  }
  if (!result.success) {
    return { mode: "inline", reason: "error_inline", estimatedSize, fileTtlSeconds: null };
  }
  if (observationPolicy === "inline") {
    return { mode: "inline", reason: "tool_policy_inline", estimatedSize, fileTtlSeconds: null };
  }
  const inline = estimatedSize <= INLINE_CHAR_LIMIT;
  return {
    mode: inline ? "inline" : "file_ref",
    reason: inline ? "size_inline" : "large_payload",
    estimatedSize,
    fileTtlSeconds: inline ? null : FILE_TTL_SECONDS,
  };
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

async function saveObservationFile(input: { toolName: string; content: unknown; decision: ObservationDecision }): Promise<ToolFile> {
  const isText = typeof input.content === "string";
  const root = await createObservationTempRoot();
  const fileName = `data_${randomUUID().replace(/-/g, "").slice(0, 8)}${isText ? ".txt" : ".json"}`;
  const filePath = path.join(root, fileName);
  await fs.promises.writeFile(filePath, isText ? (input.content as string) : stringifyJsonForFile(input.content), "utf8");
  const stat = await fs.promises.stat(filePath);
  const createdAt = Date.now() / 1000;
  const metadata: Record<string, unknown> = { tool_name: input.toolName, created_at: createdAt, reason: input.decision.reason, estimated_size: input.decision.estimatedSize, lifecycle: "transient" };
  if (input.decision.fileTtlSeconds !== null) {
    metadata.expires_at = createdAt + input.decision.fileTtlSeconds;
  }
  return { fileType: isText ? "text" : "json", path: filePath, mimeType: isText ? "text/plain" : "application/json", size: stat.size, metadata };
}

function renderLargePayloadReference(input: { result: ToolExecutionResult; file: ToolFile; estimatedSize: number }): string {
  const metadata = input.result.metadata ?? {};
  const parts: string[] = [];
  const answer = asNonEmptyString(input.result.answer);
  const approvalMessage = asNonEmptyString(metadata.approval_message);
  if (answer) { parts.push(`${answer}\n`); }
  if (approvalMessage) { parts.push(`用户批注: ${approvalMessage}\n`); }
  parts.push(`数据已写入临时文件: ${input.file.path}`);
  parts.push(renderLargePayloadMetaInfo(input.result, input.estimatedSize));
  parts.push("需要查看内容或结构时，用 read_file 或 preview_data_structure 读取（file_path 参数）");
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
  const semantic = inferToolResultSemantic(input.result);
  return renderSemanticBlock("tool_result", renderCompactToolObservation(input.result), {
    id: input.callId,
    name: input.toolName,
    ok: input.result.success ? "true" : "false",
    ...(semantic ? { semantic } : {}),
  });
}

function renderCompactToolObservation(result: ToolExecutionResult): string {
  if (!result.success) {
    return `[ERROR] ${stringifyToolContent(result.content) || "未知错误"}`;
  }
  if (result.outputType === "streams") {
    return appendLlmHint(renderStreamsObservation(result), result);
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
  if (result.media?.length) {
    const mediaSummary = `[工具返回 ${result.media.length} 张图片]`;
    observation = observation ? `${observation}\n\n${mediaSummary}` : mediaSummary;
  }
  return appendLlmHint(observation || result.summary, result);
}

function inferToolResultSemantic(result: ToolExecutionResult): string | null {
  const semantic = result.metadata.semantic;
  return typeof semantic === "string" && semantic.trim() ? semantic.trim() : null;
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

/* streams 类型渲染：进程执行结果（{stdout, stderr, return_code}）。
   裸 stdout + [stderr]/[stdout] 标记块；失败（return_code≠0）时 stderr 在前——
   错误原因优先进入模型注意力。声明该类型的工具（execute_shell、execute_skill_script 等）
   自动获得此排版，核心不认识任何工具名。 */
function renderStreamsObservation(result: ToolExecutionResult): string {
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

function stringifyJsonForFile(value: unknown): string {
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
