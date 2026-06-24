/**
 * 循环内压缩 hook（beforeModel，迁自 backend-ts runtime-compaction-hook.ts）。
 * 每轮问模型前估算工作副本 token，超阈值才触发 micro-first 重建。
 */
import type { KernelContext } from "../kernel-context.js";
import { estimateTokens } from "./token-estimate.js";

const BACKGROUND_NOTIFICATION_PREFIX = "<task-notification>";

export interface CompactionHookDeps {
  recompact: () => Promise<import("@ragsystem/agent-llm").ChatMessage[] | null>;
  budgetTokens: number;
  triggerRatio: number;
}

export function createCompactionHook(
  deps: CompactionHookDeps,
): (ctx: KernelContext) => Promise<void> {
  const threshold = Math.floor(deps.budgetTokens * deps.triggerRatio);
  return async (ctx: KernelContext): Promise<void> => {
    const tokens = ctx.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
    if (tokens < threshold) {
      return;
    }
    const rebuilt = await deps.recompact();
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
