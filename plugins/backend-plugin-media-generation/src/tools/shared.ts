import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ModelProviderConfig } from "@ragsystem/backend-core/contracts/integrations/model-adapter.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import type { BackendToolFactoryContext, PluginClientEventPublisher } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { ToolExecContext, ToolExecutionResult, ToolResultMedia } from "@ragsystem/agent-sdk";
import { isAbsolutePathLike, isPathUnder, resolvePathLike } from "@ragsystem/backend-core/tools/shared/paths.js";

import { MEDIA_IMAGE_CONFIG_KEY, MEDIA_VIDEO_CONFIG_KEY, resolveImageConfig, resolveVideoConfig } from "../config.js";
import { findModelEntry } from "../model-catalog.js";
import { findMediaVendor, type MediaAdapterId } from "../provider-types.js";
import { getMediaAdapter, resolveModelCaps } from "../providers/registry.js";
import type { MediaGenAdapter } from "../providers/types.js";
import type { ModelCaps } from "../model-catalog.js";

export const MAX_REF_IMAGE_BYTES = 10 * 1024 * 1024;

export interface MediaSetup {
  provider: ModelProviderConfig;
  adapter: MediaGenAdapter;
  adapterId: MediaAdapterId;
  model: string;
  caps: ModelCaps;
  /** video 组专用：generate_video 阻塞等待上限（秒）。 */
  waitTimeoutSeconds?: number;
}

/** 插件配置 → 厂商/凭证/模型（媒体 Provider 完全自管，与 core Provider 体系无关）。 */
export function resolveMediaSetup(
  context: BackendToolFactoryContext,
  kind: "image" | "video",
): { ok: true; setup: MediaSetup } | { ok: false; error: string } {
  if (!context.systemConfig) {
    return { ok: false, error: "媒体生成配置不可用（缺少 systemConfig 注入）" };
  }
  const capabilityLabel = kind === "image" ? "图像生成" : "视频生成";
  const group = kind === "image"
    ? {
        config: resolveImageConfig(context.systemConfig.getSection(MEDIA_IMAGE_CONFIG_KEY)),
        waitTimeoutSeconds: undefined as number | undefined,
      }
    : (() => {
        const config = resolveVideoConfig(context.systemConfig.getSection(MEDIA_VIDEO_CONFIG_KEY));
        return { config, waitTimeoutSeconds: config.wait_timeout_seconds as number | undefined };
      })();
  if (!group.config.enabled) {
    return { ok: false, error: `${capabilityLabel}未启用。请管理员在「插件设置 → 媒体生成」中开启并完成厂商/密钥/模型配置。` };
  }
  const vendor = findMediaVendor(group.config.vendor);
  if (!vendor) {
    return { ok: false, error: `${capabilityLabel}未选择厂商。请在「插件设置 → 媒体生成」中选择媒体生成厂商。` };
  }
  const apiKey = group.config.api_key.trim();
  if (!apiKey) {
    return { ok: false, error: `${capabilityLabel}未配置 API Key。请在「插件设置 → 媒体生成」填写厂商 ${vendor.label} 的 API Key。` };
  }
  const model = group.config.model_name.trim();
  if (!model) {
    return { ok: false, error: `${capabilityLabel}模型未配置。请在「插件设置 → 媒体生成」中填写生成模型名。` };
  }
  const entry = findModelEntry(model);
  if (entry && entry.adapter !== vendor.value) {
    return { ok: false, error: `模型 ${model} 属于其他厂商（${entry.adapter}），与所选厂商（${vendor.label}）不符。` };
  }
  const caps = resolveModelCaps(vendor.value, model, kind);
  const provider: ModelProviderConfig = {
    name: vendor.label,
    key: `media_${vendor.value}`,
    provider_type: vendor.value,
    api_key: apiKey,
    api_endpoint: group.config.api_endpoint.trim() || vendor.defaultEndpoint,
    timeout: group.config.timeout,
    models: [],
  };
  return {
    ok: true,
    setup: {
      provider,
      adapter: getMediaAdapter(vendor.value),
      adapterId: vendor.value,
      model,
      caps,
      ...(group.waitTimeoutSeconds !== undefined ? { waitTimeoutSeconds: group.waitTimeoutSeconds } : {}),
    },
  };
}

export function workspaceRoot(ctx: ToolExecContext): string | null {
  const root = ctx.workspaceRoot?.trim() || ctx.executionPaths?.workspace?.trim() || "";
  return root ? path.resolve(root) : null;
}

/** 读语义界内根：workspace + uploads + 系统临时目录，与 read_file 的允许范围对齐。 */
function readAccessRoots(ctx: ToolExecContext | null | undefined, workspace: string): string[] {
  const roots = [path.resolve(workspace)];
  const uploads = ctx?.executionPaths?.uploads?.trim();
  if (uploads) roots.push(path.resolve(uploads));
  roots.push(os.tmpdir());
  return roots;
}

export interface MediaPathAccess {
  ctx?: ToolExecContext | null;
  pathService?: PathAccessPolicy | null;
}

export interface LoadedRefImage {
  bytes: Buffer;
  mime: string;
  relativePath: string;
}

/** 读取参考图（界内直读；界外经路径审批放行），失败返回错误文案。 */
export async function loadWorkspaceImage(
  root: string,
  filePath: string,
  access?: MediaPathAccess,
): Promise<{ ok: true; image: LoadedRefImage } | { ok: false; error: string }> {
  const candidate = isAbsolutePathLike(filePath) ? resolvePathLike(filePath) : path.resolve(root, filePath);
  const rel = path.relative(path.resolve(root), candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const pathService = access?.pathService;
    if (!pathService) {
      return { ok: false, error: `参考图路径必须位于工作区内: ${filePath}` };
    }
    try {
      pathService.assertWithin(candidate, readAccessRoots(access?.ctx, root), filePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const mime = imageMimeForPath(candidate);
  if (!mime) {
    return { ok: false, error: `不支持的图片格式（仅 PNG/JPEG/WebP/GIF）: ${filePath}` };
  }
  try {
    const bytes = await fs.readFile(candidate);
    if (bytes.length > MAX_REF_IMAGE_BYTES) {
      return { ok: false, error: `参考图超过 10MB 上限: ${filePath}` };
    }
    return { ok: true, image: { bytes, mime, relativePath: rel.replaceAll("\\", "/") } };
  } catch {
    return { ok: false, error: `参考图读取失败（不存在或不可读）: ${filePath}` };
  }
}

function readImageExternalCandidates(root: string, filePath: string, ctx: ToolExecContext, pathService: PathAccessPolicy): string[] {
  const candidate = isAbsolutePathLike(filePath) ? resolvePathLike(filePath) : path.resolve(root, filePath);
  if (pathService.isApproved(candidate)) return [];
  if (readAccessRoots(ctx, root).some((allowedRoot) => isPathUnder(candidate, allowedRoot))) return [];
  return [candidate];
}

function outputDirExternalCandidates(root: string, outputDir: string, pathService: PathAccessPolicy): string[] {
  // 相对分支的反斜杠归一与 resolveWorkspaceRelative 保持一致，避免两侧解析漂移
  const candidate = isAbsolutePathLike(outputDir)
    ? resolvePathLike(outputDir)
    : path.resolve(root, outputDir.replaceAll("\\", "/"));
  if (pathService.isApproved(candidate)) return [];
  if (isPathUnder(candidate, path.resolve(root))) return [];
  return [candidate];
}

/** generate_image/generate_video checkAccess：越界参考图与输出目录作为候选信号交给 permission mode。 */
export function mediaAccessCandidates(
  context: BackendToolFactoryContext,
  input: Record<string, unknown>,
  ctx: ToolExecContext,
): string[] {
  const pathService = context.pathAccessPolicy;
  const root = workspaceRoot(ctx);
  if (!pathService || !root) return [];
  const candidates: string[] = [];
  const refImages = Array.isArray(input?.reference_images)
    ? input.reference_images.filter((item): item is string => typeof item === "string")
    : [];
  for (const refPath of refImages) {
    candidates.push(...readImageExternalCandidates(root, refPath, ctx, pathService));
  }
  for (const key of ["first_frame_image", "last_frame_image"] as const) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) {
      candidates.push(...readImageExternalCandidates(root, value, ctx, pathService));
    }
  }
  const outputDir = typeof input?.output_dir === "string" ? input.output_dir.trim() : "";
  if (outputDir) {
    candidates.push(...outputDirExternalCandidates(root, outputDir, pathService));
  }
  return [...new Set(candidates)];
}

function imageMimeForPath(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return null;
  }
}

export function errorResult(toolName: string, message: string): ToolExecutionResult {
  return {
    success: false,
    toolName,
    summary: message,
    answer: null,
    outputType: "error",
    content: message,
    metadata: {},
    files: [],
    llmHint: null,
  };
}

export function emitMediaEvent(
  publisher: PluginClientEventPublisher | undefined,
  sessionId: string | null | undefined,
  event: string,
  data: Record<string, unknown>,
  ctx?: ToolExecContext,
): void {
  if (!publisher || !sessionId) return;
  void publisher
    .publish(sessionId, event, data, {
      delivery: "ephemeral",
      ...(ctx?.runId ? { runId: ctx.runId } : {}),
      ...(ctx ? { callId: ctx.currentCallId ?? ctx.rootCallId ?? null } : {}),
    })
    .catch(() => undefined);
}

export function mediaResultMime(source: { type: string; mime?: string }, fallback: ToolResultMedia["mimeType"]): ToolResultMedia["mimeType"] {
  const mime = String(source.mime ?? "").toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif") return mime;
  return fallback;
}
