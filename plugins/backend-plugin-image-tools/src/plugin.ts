import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildTool, type Tool, type ToolAccessDecision, type ToolExecContext, type ToolExecutionResult, type ToolResultMedia } from "@ragsystem/agent-sdk";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import {
  DEFAULT_IMAGE_REQUEST_POLICY,
  IMAGE_REQUEST_NORMALIZER_CAPABILITY,
  type ImageRequestNormalizer,
} from "@ragsystem/backend-core/contracts/images/image-request.js";
import type {
  BackendPlugin,
  BackendToolDescriptor,
  BackendToolFactoryContext,
  PluginClientEventPublisher,
  PluginClientEventPublishOptions,
  UserMessageTransformInput,
  UserMessageTransformer,
} from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import { z } from "zod";

import {
  IMAGE_TOOLS_CONFIG_KEY,
  IMAGE_TOOLS_SYSTEM_CONFIG_EXTENSION,
  isVisionHelperEnabled,
  resolveImageToolsSystemConfig,
  type ImageToolsSystemConfig,
} from "./config.js";
import { OpenAiVisionHelper, type VisionHelper } from "./vision-client.js";

export const IMAGE_TOOLS_PLUGIN_ID = "@ragsystem/backend-plugin-image-tools";
export const VIEW_IMAGE_TOOL_NAME = "view_image";

/**
 * 插件下行事件名（plugin_event payload.event；前端按 plugin_id + event 消费）。
 * 全部为 ephemeral 进度帧：描述中 → 单图完成 → 全部完成。
 */
export const IMAGE_DESCRIBE_EVENTS = {
  started: "image.describe_started",
  progress: "image.describe_progress",
  completed: "image.describe_completed",
} as const;

export type ImageDescribeSource = "message" | "view_image";

/** 进度帧尽力而为：发布失败绝不能影响主流程（transformer 失败会丢弃全部描述结果）。 */
function emitImageEvent(
  publisher: PluginClientEventPublisher | undefined,
  sessionId: string | null | undefined,
  event: string,
  data: Record<string, unknown>,
  options?: PluginClientEventPublishOptions,
): void {
  if (!publisher || !sessionId) return;
  void publisher.publish(sessionId, event, data, { delivery: "ephemeral", ...options }).catch(() => undefined);
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/** 读取结果的 contentType 是字节真实编码（归一化变体可能换编码）；非图片值回退上传声明。 */
function imageMimeOr(contentType: string | null | undefined, fallback: string): string {
  const mime = contentType?.trim();
  return mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : fallback;
}
const IMAGE_MIME_BY_EXT: Readonly<Record<string, ToolResultMedia["mimeType"]>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  {
    name: VIEW_IMAGE_TOOL_NAME,
    description: "View an image so the model can inspect it; reads from the managed workspace (uploads included), other paths require approval.",
    category: "vision",
    risk_level: "low",
  },
];

/** 模块级共享描述缓存（key 含租户命名空间，同图不重复调用视觉模型）。 */
const describeCache = new Map<string, string>();

export function createImageToolsPlugin(): BackendPlugin {
  return {
    manifest: { id: IMAGE_TOOLS_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.transformers.register(describeUserMessageImages);
      context.tools.register(createViewImageTools, TOOL_DESCRIPTORS);
      context.runtimes.register(async (runtimeContext) => {
        const unregister = runtimeContext.systemConfig.registerExtension(
          IMAGE_TOOLS_PLUGIN_ID,
          IMAGE_TOOLS_SYSTEM_CONFIG_EXTENSION,
        );
        return { dispose: unregister };
      });
    },
  };
}

/* ── 用户消息图片描述（持久化前变换） ── */

const describeUserMessageImages: UserMessageTransformer = (input) =>
  describeUserMessageImagesWithHelper(input, (provider, config) =>
    createVisionHelper(input.tenantId, provider, config));

/** transformer 核心逻辑（helper 可注入，便于测试）。 */
export async function describeUserMessageImagesWithHelper(
  input: UserMessageTransformInput,
  createHelper: (provider: ModelProviderConfig, config: ImageToolsSystemConfig) => VisionHelper | Promise<VisionHelper>,
): Promise<MessageContentPart[] | null> {
  // 主模型支持视觉时直接看原图（与 view_image/投影层 supportsVision 同源），
  // 跳过辅助描述：省一次视觉模型调用与解析等待；代价是该消息不再持久化描述文本。
  if (input.mainModelSupportsVision === true) return null;
  const config = resolveImageToolsSystemConfig(input.systemConfig.getSection(IMAGE_TOOLS_CONFIG_KEY));
  if (!isVisionHelperEnabled(config)) return null;
  const imageParts = input.contentParts.filter(
    (part): part is Extract<MessageContentPart, { type: "attachment_ref" }> =>
      part.type === "attachment_ref" && part.kind === "image",
  );
  if (imageParts.length === 0) return null;
  const provider = findConfiguredProviderFromList(input.modelAdapter.listProviders(), config);
  if (!provider) return null;
  const helper = await createHelper(provider, config);

  const total = imageParts.length;
  const emit = (event: string, data: Record<string, unknown>) =>
    emitImageEvent(input.pluginEvents, input.sessionId, event, { source: "message" satisfies ImageDescribeSource, ...data });
  const startedAt = Date.now();
  let described = 0;
  let failed = 0;
  emit(IMAGE_DESCRIBE_EVENTS.started, { total, files: imageParts.map((part) => part.original_name) });
  try {
    // 多图并行读取与描述（互不依赖，串行会让最后一张图最坏 N×超时 才落库）；
    // 结果按下标对齐，保证描述 part 仍紧跟各自 attachment_ref 持久化。
    const descriptions = await Promise.all(imageParts.map(async (part, index) => {
      const source = await input.readAttachment(part.file_id);
      const text = source && source.body.length > 0
        ? await helper.describeImage({
            bytes: source.body,
            // 读取结果的 contentType 是字节的真实编码（归一化变体可能 png→webp/jpeg，
            // 与投影层同源优先），缺失或非图片值时回退上传声明。
            mime: imageMimeOr(source.contentType, part.mime),
            signal: input.signal ?? null,
          })
        : null;
      if (text) described += 1;
      else failed += 1;
      emit(IMAGE_DESCRIBE_EVENTS.progress, {
        file_id: part.file_id,
        name: part.original_name,
        index,
        total,
        ok: Boolean(text),
      });
      return text;
    }));

    const parts: MessageContentPart[] = [];
    let imageCursor = 0;
    for (const part of input.contentParts) {
      parts.push(part);
      if (part.type !== "attachment_ref" || part.kind !== "image") continue;
      const description = descriptions[imageCursor];
      imageCursor += 1;
      if (description) {
        // 描述以结构化 part（image_description）紧跟 attachment_ref 持久化：
        // LLM 投影按主模型视觉能力决定注入（非视觉读文本/视觉跳过），展示层按类型挂附件角标。
        parts.push({
          type: "image_description",
          file_id: part.file_id,
          original_name: part.original_name,
          text: description,
        });
      }
    }
    return parts;
  } finally {
    emit(IMAGE_DESCRIBE_EVENTS.completed, { total, described, failed, duration_ms: Date.now() - startedAt });
  }
}

/* ── view_image 工具（模型主动查看工作区图片） ── */

function createViewImageTools(context: BackendToolFactoryContext): Tool[] {
  if (!(context.agent.tools.enabled_tools ?? []).includes(VIEW_IMAGE_TOOL_NAME)) return [];
  // 部署提供的图片请求归一化（local 基于 sharp）：无实现时保持原字节 + 硬上限行为。
  const imageRequestNormalizer = context.capabilities?.get(IMAGE_REQUEST_NORMALIZER_CAPABILITY) ?? null;
  return [
    buildTool({
      name: VIEW_IMAGE_TOOL_NAME,
      description: "Read an image file from the managed workspace and return it for visual inspection.",
      category: "vision",
      source: "runtime_builtin",
      allowedCallers: ["direct"],
      inputSchema: z.object({ file_path: z.string().min(1).describe("Image path; relative paths resolve against the workspace") }).strict(),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["file_path"],
        properties: { file_path: { type: "string", description: "Image path. Relative paths resolve against the workspace; absolute paths may reach uploads or, after approval, directories outside the managed roots." } },
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      checkAccess: (input, ctx): ToolAccessDecision => {
        const rawPath = typeof input?.file_path === "string" ? input.file_path : null;
        const candidates = viewImageExternalCandidates(rawPath, ctx, context.pathAccessPolicy);
        if (candidates.length) return { action: "allow", signals: { candidatePaths: candidates } };
        return { action: "allow" };
      },
      call: (input, ctx) => readWorkspaceImage(input.file_path, ctx, context, imageRequestNormalizer),
    }),
  ];
}

/** 归一化缩放说明：给模型坐标换算提示（dsh 同款语义），未缩放返回空串。 */
function downscaledNote(shape: { width: number; height: number; originalWidth?: number; originalHeight?: number }): string {
  if (shape.originalWidth === undefined || shape.originalHeight === undefined) return "";
  const x = (shape.originalWidth / shape.width).toFixed(2);
  const y = (shape.originalHeight / shape.height).toFixed(2);
  const advice = x === y
    ? `multiply coordinates by ${x}`
    : `multiply x coordinates by ${x} and y coordinates by ${y}`;
  return ` (downscaled from ${shape.originalWidth}x${shape.originalHeight} px; ${advice} to locate features in the original file)`;
}

async function readWorkspaceImage(
  filePath: string,
  ctx: ToolExecContext,
  context: BackendToolFactoryContext,
  imageRequestNormalizer: ImageRequestNormalizer | null,
): Promise<ToolExecutionResult> {
  const root = workspaceRoot(ctx);
  if (!root) return imageError("Image path must stay inside the workspace");
  const target = isAbsolutePathLike(filePath) ? resolvePathLike(filePath) : path.resolve(root, filePath);
  if (!isPathUnder(target, root)) {
    const pathService = context.pathAccessPolicy;
    if (!pathService) return imageError("Image path must stay inside the workspace");
    try {
      pathService.assertWithin(target, readAccessRoots(ctx, root), filePath);
    } catch (error) {
      return imageError(error instanceof Error ? error.message : String(error));
    }
  }
  const mime = imageMime(target);
  if (!mime) return imageError("Only PNG, JPEG, GIF, and WebP images are supported");
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(target);
  } catch {
    return imageError(`Image could not be read: ${filePath}`);
  }
  // 客户端请求归一化：EXIF 校正/剥元数据/预算缩放（大图从"拒收"变"缩放放行"）；
  // 归一化不可用或判定 passthrough 时回退原字节，维持旧的硬上限行为。
  let effectiveMime: ToolResultMedia["mimeType"] = mime;
  let scaledNote = "";
  if (imageRequestNormalizer) {
    let normalized: Awaited<ReturnType<ImageRequestNormalizer["normalize"]>> | null = null;
    try {
      normalized = await imageRequestNormalizer.normalize({ data: bytes, mime, policy: DEFAULT_IMAGE_REQUEST_POLICY });
    } catch {
      normalized = null;
    }
    if (normalized?.kind === "normalized") {
      bytes = Buffer.from(normalized.data);
      effectiveMime = normalized.mime;
      scaledNote = downscaledNote(normalized);
    }
  }
  if (bytes.length > MAX_IMAGE_BYTES) return imageError("Image exceeds the 10 MB limit");

  // 视觉辅助描述：配置启用时生成，非视觉主模型也能"看懂"图片内容（描述随工具结果消息持久化）。
  const description = await describeImageIfConfigured(context, bytes, effectiveMime, ctx);
  const baseHint = description
    ? "The returned image may not be visible to this model; rely on the description above."
    : "Inspect the returned image and describe only relevant visual facts.";
  return {
    success: true,
    toolName: VIEW_IMAGE_TOOL_NAME,
    summary: `Read image ${filePath}${scaledNote}`,
    answer: description ? `[图片描述]\n${description}` : null,
    outputType: "image",
    content: { file_path: filePath, mime: effectiveMime, size: bytes.length },
    metadata: {},
    files: [],
    media: [{ kind: "image", mimeType: effectiveMime, source: { type: "base64", data: bytes.toString("base64") }, alt: filePath }],
    llmHint: `${baseHint}${scaledNote ? ` The image was normalized${scaledNote}.` : ""}`,
  };
}

function imageError(message: string): ToolExecutionResult {
  return {
    success: false,
    toolName: VIEW_IMAGE_TOOL_NAME,
    summary: message,
    answer: null,
    outputType: "error",
    content: message,
    metadata: {},
    files: [],
    llmHint: null,
  };
}

async function describeImageIfConfigured(
  context: BackendToolFactoryContext,
  bytes: Buffer,
  mime: string,
  ctx: ToolExecContext,
): Promise<string | null> {
  return describeImageIfConfiguredWithHelper(context, bytes, mime, ctx, (provider, config) =>
    createVisionHelper(ctx.tenantId ?? "", provider, config));
}

/** view_image 描述判定核心（helper 可注入，便于测试）。 */
export async function describeImageIfConfiguredWithHelper(
  context: BackendToolFactoryContext,
  bytes: Buffer,
  mime: string,
  ctx: ToolExecContext,
  createHelper: (provider: ModelProviderConfig, config: ImageToolsSystemConfig) => VisionHelper | Promise<VisionHelper>,
): Promise<string | null> {
  if (!context.systemConfig || !context.providers) return null;
  // 主模型支持视觉时，图片已以 image_url 进上下文（与投影层 supportsVision 同源），
  // 模型直接看图，无需辅助模型再解析一遍生成描述。
  if (context.mainModelSupportsVision === true) return null;
  const config = resolveImageToolsSystemConfig(context.systemConfig.getSection(IMAGE_TOOLS_CONFIG_KEY));
  if (!isVisionHelperEnabled(config)) return null;
  const provider = findConfiguredProviderFromList(context.providers, config);
  if (!provider) return null;
  const helper = await createHelper(provider, config);

  // run 内进度帧：带 run/call 标记，前端可据此挂到执行树节点。
  const emit = (event: string, data: Record<string, unknown>) =>
    emitImageEvent(context.pluginEvents, ctx.sessionId, event, { source: "view_image" satisfies ImageDescribeSource, ...data }, {
      runId: ctx.runId ?? null,
      callId: ctx.currentCallId ?? ctx.rootCallId ?? null,
    });
  const startedAt = Date.now();
  emit(IMAGE_DESCRIBE_EVENTS.started, { total: 1, files: [] });
  try {
    const description = await helper.describeImage({ bytes, mime, signal: ctx.signal ?? null });
    emit(IMAGE_DESCRIBE_EVENTS.progress, { index: 0, total: 1, ok: Boolean(description) });
    return description;
  } finally {
    emit(IMAGE_DESCRIBE_EVENTS.completed, { total: 1, duration_ms: Date.now() - startedAt });
  }
}

/* ── 共享辅助 ── */

function findConfiguredProviderFromList(
  providers: readonly ModelProviderConfig[],
  config: ImageToolsSystemConfig,
): ModelProviderConfig | null {
  // 与后端 findProviderByRef 语义对齐：provider 名/key 与 provider_type 均归一化（trim + 小写）后匹配。
  const providerRef = config.provider.trim().toLowerCase();
  if (!providerRef) return null;
  const providerType = config.provider_type.trim().toLowerCase();
  return providers.find((item) => {
    if (providerType && String(item.provider_type ?? "").trim().toLowerCase() !== providerType) return false;
    return [item.key, item.name].some((value) => String(value ?? "").trim().toLowerCase() === providerRef);
  }) ?? null;
}

function createVisionHelper(tenantId: string, provider: ModelProviderConfig, config: ImageToolsSystemConfig): VisionHelper {
  return new OpenAiVisionHelper({
    provider,
    modelName: config.model_name,
    maxCompletionTokens: config.max_completion_tokens,
    timeoutSeconds: config.timeout_seconds,
    cacheEnabled: config.cache_enabled,
    cache: describeCache,
    cacheNamespace: tenantId,
  });
}

function workspaceRoot(ctx: ToolExecContext): string | null {
  const root = ctx.workspaceRoot?.trim() || ctx.executionPaths?.workspace?.trim() || "";
  return root ? path.resolve(root) : null;
}

/** 读语义界内根：workspace + uploads + 系统临时目录，与 read_file 的允许范围对齐。 */
function readAccessRoots(ctx: ToolExecContext, workspace: string): string[] {
  const roots = [workspace];
  const uploads = ctx.executionPaths?.uploads?.trim();
  if (uploads) roots.push(path.resolve(uploads));
  roots.push(os.tmpdir());
  return roots;
}

function viewImageExternalCandidates(
  filePath: string | null | undefined,
  ctx: ToolExecContext,
  pathService: PathAccessPolicy,
): string[] {
  const root = workspaceRoot(ctx);
  if (!root || !filePath?.trim()) return [];
  const target = isAbsolutePathLike(filePath) ? resolvePathLike(filePath) : path.resolve(root, filePath);
  if (pathService.isApproved(target)) return [];
  if (readAccessRoots(ctx, root).some((allowedRoot) => isPathUnder(target, allowedRoot))) return [];
  return [target];
}

function imageMime(filePath: string): ToolResultMedia["mimeType"] | null {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}
