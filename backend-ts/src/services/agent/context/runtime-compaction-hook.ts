import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { KernelContext } from "../kernel/kernel-context.js";
import { estimateTokens, type ContextCompressionEvent } from "../context-compression/index.js";
import type { AgentContextService } from "./index.js";

const BACKGROUND_NOTIFICATION_PREFIX = "<task-notification>";

export interface CompactionHookDeps {
  contextService: AgentContextService;
  sessionId: string;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  runId: string;
  taskId: string | null;
  requestId: string | null;
  budgetTokens: number;
  triggerRatio: number;
  threadKey?: string | null | undefined;
  childAgentId?: string | null | undefined;
  signal?: AbortSignal | undefined;
  onCompressionEvent?: ((event: ContextCompressionEvent) => void | Promise<void>) | undefined;
}

/**
 * 循环内压缩 hook（beforeModel）：内核每轮问上下文前，估算工作副本 token，
 * 超阈值才触发 micro-first 重建（recompact：先 microcompact 廉价裁剪、按裁剪后 token
 * 重判，仍超才 LLM 压缩），并整体替换工作副本（补回本轮未入库的背景通知）。
 * recompact 返回 null 表示无裁剪且未压缩（无需替换）。
 *
 * 正常轮次仅做一次 O(n) token 估算后直接返回，不产生额外 LLM/IO。
 */
export function createCompactionHook(deps: CompactionHookDeps): (ctx: KernelContext) => Promise<void> {
  const threshold = Math.floor(deps.budgetTokens * deps.triggerRatio);
  return async (ctx: KernelContext): Promise<void> => {
    const tokens = ctx.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
    if (tokens < threshold) {
      return;
    }
    const rebuilt = await deps.contextService.recompact({
      sessionId: deps.sessionId,
      agent: deps.agent,
      provider: deps.provider,
      modelName: deps.modelName,
      runId: deps.runId,
      taskId: deps.taskId,
      requestId: deps.requestId,
      threadKey: deps.threadKey,
      childAgentId: deps.childAgentId,
      signal: deps.signal,
      onCompressionEvent: deps.onCompressionEvent,
    });
    if (!rebuilt) {
      return;
    }
    // 重建自 store，丢失本轮经 refresher 注入、尚未入库的背景通知，替换后补回。
    const pendingNotifications = ctx.messages.filter((message) =>
      message.content.startsWith(BACKGROUND_NOTIFICATION_PREFIX),
    );
    ctx.replaceAll(rebuilt);
    if (pendingNotifications.length) {
      ctx.appendMessages(pendingNotifications);
    }
  };
}
