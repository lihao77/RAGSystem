import { buildTool, type Tool, type ToolExecContext, type ToolExecutionResult, type ToolResultMedia } from "@ragsystem/agent-sdk";
import type { BackendToolFactoryContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { z } from "zod";

import { downloadBinary } from "../http.js";
import { MEDIA_IMAGE_CONFIG_KEY, resolveImageConfig } from "../config.js";
import { imageExtensionForMime, persistMediaFile } from "../storage.js";
import { normalizeImageParams } from "../providers/registry.js";
import { emitMediaEvent, errorResult, loadWorkspaceImage, mediaResultMime, resolveMediaSetup, workspaceRoot, type MediaSetup } from "./shared.js";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export const MEDIA_IMAGE_EVENTS = {
  started: "media.image_started",
  completed: "media.image_completed",
  failed: "media.image_failed",
} as const;

const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** 参考图总量上限（base64 进请求体，防超大多图把请求体撑到百 MB 级）。 */
const MAX_TOTAL_REF_IMAGE_BYTES = 40 * 1024 * 1024;

const GenerateImageInput = z.object({
  prompt: z.string().min(1).describe("图像描述（中英文皆可；越具体效果越好）"),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional().describe("宽高比，默认 1:1"),
  resolution: z.enum(["1k", "2k", "4k"]).optional().describe("分辨率档，默认取系统配置"),
  n: z.number().int().min(1).max(4).optional().describe("生成张数（1-4）"),
  reference_images: z.array(z.string().min(1)).max(10).optional().describe("参考图的工作区相对路径（图生图/编辑；需模型支持）"),
  output_dir: z.string().optional().describe("保存目录（工作区相对），默认 media/images"),
}).strict();

export type GenerateImageInput = z.infer<typeof GenerateImageInput>;

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "图像描述（中英文皆可；越具体效果越好）" },
    aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], description: "宽高比，默认 1:1" },
    resolution: { type: "string", enum: ["1k", "2k", "4k"], description: "分辨率档，默认取系统配置" },
    n: { type: "integer", minimum: 1, maximum: 4, description: "生成张数（1-4）" },
    reference_images: { type: "array", items: { type: "string" }, maxItems: 10, description: "参考图的工作区相对路径（图生图/编辑；需模型支持）" },
    output_dir: { type: "string", description: "保存目录（工作区相对），默认 media/images" },
  },
} as const;

export function buildGenerateImageTool(context: BackendToolFactoryContext): Tool {
  return buildTool({
    name: GENERATE_IMAGE_TOOL_NAME,
    description:
      "Generate images from text (and optionally reference images from the workspace) via the configured media provider. " +
      "Returns generated image files saved into the session workspace; embed them in the final answer with <file_ref path=\"...\" presentation=\"inline\"/> markers.",
    category: "media",
    source: "runtime_builtin",
    allowedCallers: ["direct"],
    inputSchema: GenerateImageInput,
    parameters: PARAMETERS,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    call: (input, ctx) => executeGenerateImage(input, ctx, context),
  });
}

/** 核心执行（setup 可注入，便于测试）。 */
export async function executeGenerateImage(
  input: GenerateImageInput,
  ctx: ToolExecContext,
  context: BackendToolFactoryContext,
  injectedSetup?: MediaSetup,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const resolved = injectedSetup ? { ok: true as const, setup: injectedSetup } : resolveMediaSetup(context, "image");
  if (!resolved.ok) return errorResult(GENERATE_IMAGE_TOOL_NAME, resolved.error);
  const setup = resolved.setup;
  if (setup.caps.kind !== "image") {
    return errorResult(GENERATE_IMAGE_TOOL_NAME, `模型 ${setup.model} 不是图像生成模型`);
  }

  const root = workspaceRoot(ctx);
  if (!root) return errorResult(GENERATE_IMAGE_TOOL_NAME, "会话工作区不可用，无法保存生成图片");

  const defaultResolution = resolveDefaultResolution(context);
  const params = normalizeImageParams(setup.caps, {
    aspectRatio: input.aspect_ratio,
    resolutionTier: input.resolution ?? defaultResolution,
    n: input.n,
  });

  // 参考图（图生图）：能力检查 + 读取。
  const refPaths = input.reference_images ?? [];
  const notes = [...params.notes];
  if (refPaths.length > 0 && setup.caps.maxRefImages === 0) {
    return errorResult(
      GENERATE_IMAGE_TOOL_NAME,
      `模型 ${setup.model} 不支持参考图（纯文生图）。请直接描述画面，或在设置中切换支持参考图的模型（如 Seedream / 万相 / gpt-image / nano banana）。`,
    );
  }
  if (refPaths.length > setup.caps.maxRefImages) {
    notes.push(`参考图已截取前 ${setup.caps.maxRefImages} 张（上限）`);
  }
  const refImages = [];
  let refTotalBytes = 0;
  for (const refPath of refPaths.slice(0, setup.caps.maxRefImages)) {
    const loaded = await loadWorkspaceImage(root, refPath);
    if (!loaded.ok) return errorResult(GENERATE_IMAGE_TOOL_NAME, loaded.error);
    refTotalBytes += loaded.image.bytes.length;
    if (refTotalBytes > MAX_TOTAL_REF_IMAGE_BYTES) {
      return errorResult(GENERATE_IMAGE_TOOL_NAME, `参考图总大小超过 ${Math.round(MAX_TOTAL_REF_IMAGE_BYTES / 1024 / 1024)}MB 上限，请减少张数或压缩图片。`);
    }
    refImages.push({ bytes: loaded.image.bytes, mime: loaded.image.mime });
  }

  emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_IMAGE_EVENTS.started, {
    model: setup.model,
    aspect_ratio: params.aspectRatio,
    resolution: params.resolutionTier,
    n: params.n,
    ref_images: refPaths.length,
  }, ctx);

  let outputs;
  try {
    outputs = await setup.adapter.generateImage(
      {
        prompt: input.prompt,
        aspectRatio: params.aspectRatio as never,
        resolutionTier: params.resolutionTier as never,
        n: params.n,
        refImages,
        watermark: false,
      },
      setup.model,
      { provider: setup.provider, signal: ctx.signal ?? null },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_IMAGE_EVENTS.failed, { model: setup.model, error: message }, ctx);
    return errorResult(GENERATE_IMAGE_TOOL_NAME, message);
  }

  // 转存（厂商 URL 有效期 1h-24h，必须立即落盘）。
  const outputDir = input.output_dir?.trim() || "media/images";
  const saved: Array<{ relativePath: string; mime: string; size: number }> = [];
  const inlineMedia: ToolResultMedia[] = [];
  const persistErrors: string[] = [];
  for (const [index, output] of outputs.entries()) {
    try {
      let bytes: Buffer;
      let mime: ToolResultMedia["mimeType"];
      if (output.type === "base64") {
        bytes = Buffer.from(output.data, "base64");
        mime = mediaResultMime(output, "image/png");
      } else {
        // url 源以下载响应 content-type 为准（jpg/webp 不得误存为 png）
        const downloaded = await downloadBinary(output.url, { signal: ctx.signal ?? null });
        bytes = downloaded.bytes;
        mime = mediaResultMime({ type: "url", mime: downloaded.contentType }, "image/png");
      }
      const persisted = await persistMediaFile({
        workspaceRoot: root,
        outputDir,
        baseName: "img",
        bytes,
        ext: imageExtensionForMime(mime),
      });
      saved.push({ relativePath: persisted.relativePath, mime, size: persisted.size });
      if (index < MAX_INLINE_IMAGES && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
        inlineMedia.push({
          kind: "image",
          mimeType: mime,
          source: { type: "base64", data: bytes.toString("base64") },
          alt: persisted.relativePath,
        });
      }
    } catch (error) {
      persistErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (saved.length === 0) {
    const message = persistErrors[0] ?? "生成结果转存失败";
    emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_IMAGE_EVENTS.failed, { model: setup.model, error: message }, ctx);
    return errorResult(GENERATE_IMAGE_TOOL_NAME, message);
  }

  emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_IMAGE_EVENTS.completed, {
    model: setup.model,
    files: saved.map((item) => item.relativePath),
    duration_ms: Date.now() - startedAt,
  }, ctx);

  const fileList = saved.map((item) => `- ${item.relativePath}`).join("\n");
  return {
    success: true,
    toolName: GENERATE_IMAGE_TOOL_NAME,
    summary: `生成 ${saved.length} 张图片（${setup.model}）`,
    answer: `已生成 ${saved.length} 张图片并保存到工作区：\n${fileList}${notes.length ? `\n${notes.join("；")}` : ""}`,
    outputType: "image",
    content: {
      files: saved,
      model: setup.model,
      provider: setup.provider.name,
      aspect_ratio: params.aspectRatio,
      resolution: params.resolutionTier,
      notes,
      ...(persistErrors.length ? { persist_errors: persistErrors } : {}),
    },
    metadata: {
      provider: setup.provider.name,
      model: setup.model,
      aspect_ratio: params.aspectRatio,
      resolution: params.resolutionTier,
      elapsed_ms: Date.now() - startedAt,
    },
    files: [],
    media: inlineMedia,
    llmHint:
      `在最终回答中用 <file_ref path="${saved[0]!.relativePath}" presentation="inline" caption="简短说明"/> 标记嵌入图片（多张则多个标记），` +
      "标记必须独占一行、使用工作区相对路径；先直观检查图片是否符合要求再交付。",
  };
}

function resolveDefaultResolution(context: BackendToolFactoryContext): string | undefined {
  if (!context.systemConfig) return undefined;
  return resolveImageConfig(context.systemConfig.getSection(MEDIA_IMAGE_CONFIG_KEY)).default_resolution;
}
