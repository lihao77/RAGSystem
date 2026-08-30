import { buildTool, type Tool, type ToolAccessDecision, type ToolExecContext, type ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { BackendToolFactoryContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { z } from "zod";

import { emitMediaEvent, errorResult, mediaAccessCandidates, resolveMediaSetup, workspaceRoot, type MediaSetup } from "./shared.js";
import { MEDIA_VIDEO_EVENTS, persistVideoResult } from "./GenerateVideoTool.js";

export const CHECK_VIDEO_TASK_TOOL_NAME = "check_video_task";

const CheckVideoTaskInput = z.object({
  task_ref: z.string().min(3).describe("generate_video 返回的任务引用（格式 adapter:jobId）"),
  output_dir: z.string().optional().describe("保存目录（工作区相对；界外绝对路径需审批），默认 media/videos，与 generate_video 一致"),
}).strict();

export type CheckVideoTaskInput = z.infer<typeof CheckVideoTaskInput>;

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["task_ref"],
  properties: {
    task_ref: { type: "string", description: "generate_video 返回的任务引用（格式 adapter:jobId）" },
    output_dir: { type: "string", description: "保存目录（工作区相对；界外绝对路径需审批），默认 media/videos，与 generate_video 一致" },
  },
} as const;

/** jobId 为 LLM 可控输入且直接拼进厂商 URL：白名单防路径注入（google operation 名含 /）。 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)*$/;

/** 字符白名单之外，整段 "." / ".."（路径穿越）也必须拒绝。 */
function isSafeJobId(jobId: string): boolean {
  if (!JOB_ID_PATTERN.test(jobId)) return false;
  return jobId.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function buildCheckVideoTaskTool(context: BackendToolFactoryContext): Tool {
  return buildTool({
    name: CHECK_VIDEO_TASK_TOOL_NAME,
    description:
      "Check a previously submitted video generation task (task_ref from generate_video). " +
      "Single non-blocking poll: returns the saved video file when succeeded, current status when still running.",
    category: "media",
    source: "runtime_builtin",
    allowedCallers: ["direct"],
    inputSchema: CheckVideoTaskInput,
    parameters: PARAMETERS,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    checkAccess: (input, ctx): ToolAccessDecision => {
      const candidates = mediaAccessCandidates(context, input, ctx);
      if (candidates.length) return { action: "allow", signals: { candidatePaths: candidates } };
      return { action: "allow" };
    },
    call: (input, ctx) => executeCheckVideoTask(input, ctx, context),
  });
}

export async function executeCheckVideoTask(
  input: CheckVideoTaskInput,
  ctx: ToolExecContext,
  context: BackendToolFactoryContext,
  injectedSetup?: MediaSetup,
): Promise<ToolExecutionResult> {
  const taskRef = input.task_ref.trim();
  const separator = taskRef.indexOf(":");
  if (separator <= 0 || separator >= taskRef.length - 1) {
    return errorResult(CHECK_VIDEO_TASK_TOOL_NAME, `task_ref 格式非法（应为 adapter:jobId）: ${taskRef}`);
  }
  const adapterId = taskRef.slice(0, separator);
  const jobId = taskRef.slice(separator + 1);
  if (!isSafeJobId(jobId)) {
    return errorResult(CHECK_VIDEO_TASK_TOOL_NAME, `task_ref 中的 jobId 含非法字符: ${jobId}`);
  }

  const resolved = injectedSetup ? { ok: true as const, setup: injectedSetup } : resolveMediaSetup(context, "video");
  if (!resolved.ok) return errorResult(CHECK_VIDEO_TASK_TOOL_NAME, resolved.error);
  const setup = resolved.setup;
  if (setup.adapterId !== adapterId) {
    return errorResult(
      CHECK_VIDEO_TASK_TOOL_NAME,
      `task_ref 的厂商（${adapterId}）与当前视频生成配置（${setup.adapterId}）不符，请检查插件设置中的 Provider 选择。`,
    );
  }

  let status;
  try {
    status = await setup.adapter.pollVideoJob(jobId, setup.model, { provider: setup.provider, signal: ctx.signal ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.failed, { model: setup.model, task_ref: taskRef, error: message }, ctx);
    return errorResult(CHECK_VIDEO_TASK_TOOL_NAME, message);
  }

  if (status.status === "failed") {
    return errorResult(CHECK_VIDEO_TASK_TOOL_NAME, status.error ?? "厂商侧视频生成失败");
  }
  if (status.status === "succeeded" && status.outputs) {
    const root = workspaceRoot(ctx);
    if (!root) return errorResult(CHECK_VIDEO_TASK_TOOL_NAME, "会话工作区不可用，无法保存生成视频");
    return await persistVideoResult({
      toolName: CHECK_VIDEO_TASK_TOOL_NAME,
      outputs: status.outputs,
      workspaceRoot: root,
      outputDir: input.output_dir?.trim() || "media/videos",
      context,
      ctx,
      setup,
      taskRef,
      metadata: { task_ref: taskRef },
    });
  }

  // 仍在生成：返回状态（不阻塞等待）。
  emitMediaEvent(context.pluginEvents, ctx.sessionId, MEDIA_VIDEO_EVENTS.progress, {
    task_ref: taskRef,
    status: status.progressHint ?? "running",
  }, ctx);
  return {
    success: true,
    toolName: CHECK_VIDEO_TASK_TOOL_NAME,
    summary: `视频仍在生成中（${status.progressHint ?? "running"}）`,
    answer: `视频任务 ${taskRef} 仍在生成中（${status.progressHint ?? "running"}）。请等待约 30-60 秒后再次查询。`,
    outputType: "text",
    content: { status: "running", task_ref: taskRef, hint: status.progressHint ?? "running" },
    metadata: { task_ref: taskRef },
    files: [],
    llmHint: "向用户简要汇报进度即可，稍后再次调用 check_video_task（相同 task_ref）。",
  };
}
