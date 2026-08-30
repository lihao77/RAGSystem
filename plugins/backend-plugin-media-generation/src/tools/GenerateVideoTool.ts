import { buildTool, type Tool, type ToolAccessDecision, type ToolExecContext, type ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { BackendToolFactoryContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { z } from "zod";

import { downloadBinary } from "../http.js";
import { MEDIA_VIDEO_CONFIG_KEY, resolveVideoConfig } from "../config.js";
import { normalizeVideoParams } from "../providers/registry.js";
import type { VideoJobOutputs } from "../providers/types.js";
import { isPathOutsideWorkspace, normalizeMediaMime, persistMediaFile, videoExtensionForMime, imageExtensionForMime } from "../storage.js";
import { emitMediaEvent, errorResult, loadWorkspaceImage, mediaAccessCandidates, resolveMediaSetup, workspaceRoot, type MediaSetup } from "./shared.js";

export const GENERATE_VIDEO_TOOL_NAME = "generate_video";
export const CHECK_VIDEO_TASK_TOOL_NAME = "check_video_task";

export const MEDIA_VIDEO_EVENTS = {
  started: "media.video_started",
  progress: "media.video_progress",
  completed: "media.video_completed",
  failed: "media.video_failed",
} as const;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 240;

const GenerateVideoInput = z.object({
  prompt: z.string().min(1).describe("视频内容描述（镜头、主体、动作、风格）"),
  duration_seconds: z.number().int().min(1).max(60).optional().describe("时长（秒），按模型能力自动夹取"),
  resolution: z.enum(["720p", "1080p"]).optional().describe("分辨率，默认取系统配置"),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional().describe("宽高比，默认 16:9"),
  with_audio: z.boolean().optional().describe("是否生成音频（需模型支持）"),
  first_frame_image: z.string().optional().describe("首帧图路径（工作区相对，或经审批的外部绝对路径；图生视频）"),
  last_frame_image: z.string().optional().describe("尾帧图路径（工作区相对，或经审批的外部绝对路径；首尾帧插值；需模型支持）"),
  output_dir: z.string().optional().describe("保存目录（工作区相对；界外绝对路径需审批），默认 media/videos"),
}).strict();

export type GenerateVideoInput = z.infer<typeof GenerateVideoInput>;

const VIDEO_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "视频内容描述（镜头、主体、动作、风格）" },
    duration_seconds: { type: "integer", minimum: 1, maximum: 60, description: "时长（秒），按模型能力自动夹取" },
    resolution: { type: "string", enum: ["720p", "1080p"], description: "分辨率，默认取系统配置" },
    aspect_ratio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], description: "宽高比，默认 16:9" },
    with_audio: { type: "boolean", description: "是否生成音频（需模型支持）" },
    first_frame_image: { type: "string", description: "首帧图路径（工作区相对，或经审批的外部绝对路径；图生视频）" },
    last_frame_image: { type: "string", description: "尾帧图路径（工作区相对，或经审批的外部绝对路径；首尾帧插值；需模型支持）" },
    output_dir: { type: "string", description: "保存目录（工作区相对；界外绝对路径需审批），默认 media/videos" },
  },
} as const;

export function buildGenerateVideoTool(context: BackendToolFactoryContext): Tool {
  return buildTool({
    name: GENERATE_VIDEO_TOOL_NAME,
    description:
      "Generate a video from text (and optionally a first/last frame image from the workspace) via the configured media provider. " +
      "Video generation is asynchronous: the tool waits up to the configured timeout, then either returns the saved video file " +
      "or a task_ref for check_video_task. Embed the result with <file_ref path=\"...\" presentation=\"inline\"/>.",
    category: "media",
    source: "runtime_builtin",
    allowedCallers: ["direct"],
    inputSchema: GenerateVideoInput,
    parameters: VIDEO_PARAMETERS,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    checkAccess: (input, ctx): ToolAccessDecision => {
      const candidates = mediaAccessCandidates(context, input, ctx);
      if (candidates.length) return { action: "allow", signals: { candidatePaths: candidates } };
      return { action: "allow" };
    },
    call: (input, ctx) => executeGenerateVideo(input, ctx, context),
  });
}

/** 轮询节奏：5s 起步 ×1.25 递增至 15s 上限。 */
function nextPollDelay(currentMs: number): number {
  return Math.min(Math.round(currentMs * 1.25), 15_000);
}

export async function executeGenerateVideo(
  input: GenerateVideoInput,
  ctx: ToolExecContext,
  context: BackendToolFactoryContext,
  injectedSetup?: MediaSetup,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const resolved = injectedSetup ? { ok: true as const, setup: injectedSetup } : resolveMediaSetup(context, "video");
  if (!resolved.ok) return errorResult(GENERATE_VIDEO_TOOL_NAME, resolved.error);
  const setup = resolved.setup;
  if (setup.caps.kind !== "video") {
    return errorResult(GENERATE_VIDEO_TOOL_NAME, `模型 ${setup.model} 不是视频生成模型`);
  }

  const root = workspaceRoot(ctx);
  if (!root) return errorResult(GENERATE_VIDEO_TOOL_NAME, "会话工作区不可用，无法保存生成视频");

  const params = normalizeVideoParams(setup.caps, {
    aspectRatio: input.aspect_ratio ?? "16:9",
    resolution: input.resolution ?? defaultVideoResolution(context),
    durationSeconds: input.duration_seconds,
    withAudio: input.with_audio,
  });

  const notes = [...params.notes];
  const frames: { first?: { bytes: Buffer; mime: string }; last?: { bytes: Buffer; mime: string } } = {};
  if (input.first_frame_image) {
    if (!setup.caps.supportsFirstFrame) {
      return errorResult(GENERATE_VIDEO_TOOL_NAME, `模型 ${setup.model} 不支持图生视频（首帧）。请改用纯文生视频或换用 wan2.7-i2v / Seedance / CogVideoX 等支持模型。`);
    }
    const loaded = await loadWorkspaceImage(root, input.first_frame_image, { ctx, pathService: context.pathAccessPolicy });
    if (!loaded.ok) return errorResult(GENERATE_VIDEO_TOOL_NAME, loaded.error);
    frames.first = { bytes: loaded.image.bytes, mime: loaded.image.mime };
  }
  if (input.last_frame_image) {
    if (!setup.caps.supportsLastFrame) {
      return errorResult(GENERATE_VIDEO_TOOL_NAME, `模型 ${setup.model} 不支持尾帧（首尾帧插值）。`);
    }
    if (!frames.first) {
      return errorResult(GENERATE_VIDEO_TOOL_NAME, "last_frame_image 需要与 first_frame_image 同时提供。");
    }
    const loaded = await loadWorkspaceImage(root, input.last_frame_image, { ctx, pathService: context.pathAccessPolicy });
    if (!loaded.ok) return errorResult(GENERATE_VIDEO_TOOL_NAME, loaded.error);
    frames.last = { bytes: loaded.image.bytes, mime: loaded.image.mime };
  }

  let jobId: string;
  try {
    const submitted = await setup.adapter.submitVideoJob(
      {
        prompt: input.prompt,
        durationSeconds: params.durationSeconds,
        resolution: params.resolution as never,
        aspectRatio: params.aspectRatio as never,
        withAudio: params.withAudio,
        ...(frames.first ? { firstFrame: frames.first } : {}),
        ...(frames.last ? { lastFrame: frames.last } : {}),
      },
      setup.model,
      { provider: setup.provider, signal: ctx.signal ?? null },
    );
    jobId = submitted.jobId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.failed, { model: setup.model, error: message }, ctx);
    return errorResult(GENERATE_VIDEO_TOOL_NAME, message);
  }

  const taskRef = `${setup.adapterId}:${jobId}`;
  emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.started, {
    model: setup.model,
    task_ref: taskRef,
    duration_seconds: params.durationSeconds,
    resolution: params.resolution,
  }, ctx);

  // 阻塞轮询直到完成 / 超时 / 取消（远端任务不取消，超时后可续查）。
  const timeoutMs = (setup.waitTimeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 5_000;
  while (true) {
    if (ctx.signal?.aborted) {
      return errorResult(
        GENERATE_VIDEO_TOOL_NAME,
        `已停止等待视频生成（任务未取消，task_ref: ${taskRef}）。稍后可用 check_video_task 查询。`,
      );
    }
    let status;
    try {
      status = await setup.adapter.pollVideoJob(jobId, setup.model, { provider: setup.provider, signal: ctx.signal ?? null });
    } catch (error) {
      // 查询失败 ≠ 任务失败：任务已提交并计费在途，必须保留 task_ref 供续查。
      const message = error instanceof Error ? error.message : String(error);
      const stopped = ctx.signal?.aborted === true;
      emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.failed, { model: setup.model, task_ref: taskRef, error: message }, ctx);
      return {
        success: true,
        toolName: GENERATE_VIDEO_TOOL_NAME,
        summary: stopped ? `已停止等待视频生成（task_ref: ${taskRef}）` : `视频任务查询失败，任务仍在厂商侧（task_ref: ${taskRef}）`,
        answer:
          `${stopped ? "已停止等待" : "查询厂商状态失败"}（${message}）。任务未取消，task_ref: ${taskRef}\n` +
          "请稍后调用 check_video_task 查询；完成后再把视频嵌入回答。",
        outputType: "text",
        content: { status: "pending", task_ref: taskRef, model: setup.model, query_error: message },
        metadata: { task_ref: taskRef, model: setup.model },
        files: [],
        llmHint: "任务仍在厂商侧执行，稍后调用 check_video_task（task_ref 见上）获取结果。",
      };
    }
    if (status.status === "failed") {
      const message = status.error ?? "厂商侧视频生成失败";
      emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.failed, { model: setup.model, task_ref: taskRef, error: message }, ctx);
      return errorResult(GENERATE_VIDEO_TOOL_NAME, message);
    }
    if (status.status === "succeeded" && status.outputs) {
      return await persistVideoResult({
        toolName: GENERATE_VIDEO_TOOL_NAME,
        outputs: status.outputs,
        workspaceRoot: root,
        outputDir: input.output_dir?.trim() || "media/videos",
        context,
        ctx,
        setup,
        taskRef,
        metadata: {
          duration_seconds: params.durationSeconds,
          resolution: params.resolution,
          aspect_ratio: params.aspectRatio,
          notes,
          elapsed_ms: Date.now() - startedAt,
        },
      });
    }
    if (Date.now() + delayMs >= deadline) {
      // 超时：提交本身成功，返回 task_ref 引导续查（不改判为失败）。
      return {
        success: true,
        toolName: GENERATE_VIDEO_TOOL_NAME,
        summary: `视频仍在生成中（task_ref: ${taskRef}）`,
        answer:
          `视频任务已提交（${setup.model}，${params.durationSeconds}s/${params.resolution}），等待超过 ${Math.round(timeoutMs / 1000)}s 尚未完成。\n` +
          `task_ref: ${taskRef}\n请稍后（建议 30-60 秒后）调用 check_video_task 查询；完成后再把视频嵌入回答。`,
        outputType: "text",
        content: { status: "pending", task_ref: taskRef, model: setup.model, duration_seconds: params.durationSeconds },
        metadata: { task_ref: taskRef, model: setup.model },
        files: [],
        llmHint: "先回答用户当前问题并说明视频正在生成，随后调用 check_video_task（task_ref 见上）获取结果。",
      };
    }
    emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.progress, {
      task_ref: taskRef,
      status: status.progressHint ?? "running",
      waited_ms: Date.now() - startedAt,
    }, ctx);
    await sleep(delayMs, ctx.signal ?? null);
    delayMs = nextPollDelay(delayMs);
  }
}

/** 成功结果统一落盘（generate_video 与 check_video_task 共用）。 */
export async function persistVideoResult(input: {
  toolName: string;
  outputs: VideoJobOutputs;
  workspaceRoot: string;
  outputDir: string;
  context: BackendToolFactoryContext;
  ctx: ToolExecContext;
  setup: MediaSetup;
  /** 失败信息中附带的任务引用（下载失败后可重试 check_video_task 再取）。 */
  taskRef?: string;
  metadata?: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const { outputs, setup } = input;
  try {
    let videoBytes: Buffer;
    let videoMime: string;
    if (outputs.video.type === "bytes") {
      videoBytes = outputs.video.data;
      videoMime = normalizeMediaMime(outputs.video.mime, "video/mp4");
    } else {
      const downloaded = await downloadBinary(outputs.video.url, { signal: input.ctx.signal ?? null });
      videoBytes = downloaded.bytes;
      // 以响应 content-type 为准（url 源可能返回 webm/mov）
      videoMime = normalizeMediaMime(downloaded.contentType, "video/mp4");
    }
    const video = await persistMediaFile({
      workspaceRoot: input.workspaceRoot,
      outputDir: input.outputDir,
      baseName: "vid",
      bytes: videoBytes,
      ext: videoExtensionForMime(videoMime),
      pathService: input.context.pathAccessPolicy,
    });
    let coverPath: string | null = null;
    if (outputs.cover?.type === "url") {
      try {
        const cover = await downloadBinary(outputs.cover.url, { signal: input.ctx.signal ?? null });
        const persisted = await persistMediaFile({
          workspaceRoot: input.workspaceRoot,
          outputDir: input.outputDir,
          baseName: "cover",
          bytes: cover.bytes,
          ext: imageExtensionForMime(normalizeMediaMime(cover.contentType, "image/jpeg")),
          pathService: input.context.pathAccessPolicy,
        });
        coverPath = persisted.relativePath;
      } catch {
        // 封面是附属产物，失败不影响主结果。
      }
    }

    emitMediaEvent(input.context.pluginEvents, input.ctx.sessionId, MEDIA_VIDEO_EVENTS.completed, {
      model: setup.model,
      file: video.relativePath,
      size: video.size,
    }, input.ctx);

    // 界外目录（经审批放行）的产物无法用工作区 file_ref 通道内嵌展示，文案需分流
    const externalOutput = isPathOutsideWorkspace(input.workspaceRoot, input.outputDir);
    return {
      success: true,
      toolName: input.toolName,
      summary: `视频已生成并保存: ${video.relativePath}`,
      answer: `视频已生成（${setup.model}，${(video.size / 1024 / 1024).toFixed(1)}MB）并保存到${externalOutput ? "审批放行的外部目录" : "工作区"}：${video.relativePath}${coverPath ? `\n封面: ${coverPath}` : ""}`,
      outputType: "text",
      content: { file: video.relativePath, size: video.size, mime: videoMime, ...(coverPath ? { cover: coverPath } : {}), ...(input.metadata ?? {}) },
      metadata: { provider: setup.provider.name, model: setup.model, ...(input.metadata ?? {}) },
      files: [],
      llmHint: externalOutput
        ? "视频已保存到审批放行的外部目录（见 answer 中的绝对路径）；该目录不在工作区内，无法用 file_ref 内嵌展示，用文字告知保存位置即可。"
        : `在最终回答中用 <file_ref path="${video.relativePath}" presentation="inline" caption="视频说明"/> 标记嵌入视频（独占一行、工作区相对路径）。`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitMediaEvent(input.context.pluginEvents, input.ctx.sessionId, MEDIA_VIDEO_EVENTS.failed, { model: setup.model, ...(input.taskRef ? { task_ref: input.taskRef } : {}), error: message }, input.ctx);
    const retryHint = input.taskRef
      ? `（任务已在厂商侧完成，可用 check_video_task 重试下载，task_ref: ${input.taskRef}）`
      : "";
    return errorResult(input.toolName, `视频下载/保存失败: ${message}${retryHint}`);
  }
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defaultVideoResolution(context: BackendToolFactoryContext): string | undefined {
  if (!context.systemConfig) return undefined;
  return resolveVideoConfig(context.systemConfig.getSection(MEDIA_VIDEO_CONFIG_KEY)).default_resolution;
}
