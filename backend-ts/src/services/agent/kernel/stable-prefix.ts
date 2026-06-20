/**
 * Agent 微内核 — stable-prefix 缓存刷新（共享函数）。
 *
 * 合并 run-engine.ts L497-519 与 delegation.ts L423-440 两份重复实现。
 * 两份逻辑一致，仅差异：
 * - run-engine：fp 内联写成局部变量 + 失败时 logger.error 记日志；
 * - delegation：fp 直接内联在 patch 里 + 失败时静默 catch。
 *
 * 本函数取并集：保留 fp 局部变量写法（run-engine 版），try/catch 必留；
 * logger 可选——传入则走 run-engine 的 error 记录路径，不传则退化为 delegation 的静默。
 * 写入 _pipeline_caches[threadKey] = { fp, t: <epoch 秒> } 元数据，与现状逐字一致。
 */

import type { ISessionStore } from "../../../contracts/conversation-store/index.js";

/**
 * 结构化 logger 最小接口（对齐 run-engine 注入的 logger.error 形态）。
 * 传入 run-engine/delegation 自身 logger 即可复用其传输通道。
 */
export interface StablePrefixLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * 刷新 stable-prefix 指纹缓存（机会性写，失败不影响模型响应）。
 *
 * @param conversationStore 会话存储（updateSessionMetadata 写 _pipeline_caches）。
 * @param sessionId 会话 ID。
 * @param threadKey 线程键（写入缓存子键）。
 * @param stablePrefixFingerprint stable-prefix 指纹；空/空白落 "no_stable_prefix"。
 * @param logger 可选；传入则失败时记录结构化错误日志，否则静默。
 */
export function refreshStablePrefixCache(
  conversationStore: ISessionStore,
  sessionId: string,
  threadKey: string,
  stablePrefixFingerprint: string | null | undefined,
  logger?: StablePrefixLogger,
): void {
  const fp = stablePrefixFingerprint?.trim() || "no_stable_prefix";
  try {
    conversationStore.updateSessionMetadata(sessionId, {
      _pipeline_caches: {
        [threadKey]: {
          fp,
          t: Date.now() / 1000,
        },
      },
    });
  } catch (error) {
    if (logger) {
      logger.error(
        {
          session_id: sessionId,
          thread_key: threadKey,
          error: error instanceof Error ? error.message : String(error),
        },
        "failed to refresh stable prefix cache",
      );
    }
    // Cache refresh is opportunistic; the model response should still complete.
  }
}
