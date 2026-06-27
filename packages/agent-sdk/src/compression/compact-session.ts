/**
 * compactSession —— 外部手动压缩入口（如 backend /compact）。
 *
 * 与 run 内自动压缩（round.before hook → compressIfNeeded）共享同一执行体
 * （loadHistory → selectSegment → summarizeSegment → insertCompressionMessage），
 * 走 forceCompact（无阈值门控）。busy 守卫不在 SDK——SDK 是 per-run 一次性、不持有跨 run
 * session 状态；调用方（backend）用自己的 active-run 追踪（statusTracker）在调本入口前拦截。
 *
 * provider/modelName 不传——从 profile.llmTiers（fast→default）自取（投影层已算死）。
 * llm 不传——SDK 内部用 agent-llm 默认实现（getDefaultLlmClient 单例，与 createRuntime 一致）。
 */
import { getDefaultLlmClient } from "../llm-client.js";
import type { RuntimeStore } from "../contracts.js";
import type { AgentProfile } from "../types.js";
import { AgentContextCompressionService, type CompressInput, type ContextCompressionResult } from "./context-compression.js";

export interface CompactSessionInput {
  sessionId: string;
  store: RuntimeStore;
  profile: AgentProfile;
  threadKey?: string | null;
  signal?: AbortSignal;
}

export type CompactSessionResult = ContextCompressionResult;

export async function compactSession(input: CompactSessionInput): Promise<CompactSessionResult> {
  const llm = getDefaultLlmClient();
  const service = new AgentContextCompressionService({ store: input.store, llm, profile: input.profile });
  const compressInput: CompressInput = {
    sessionId: input.sessionId,
    ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return service.forceCompact(compressInput);
}
