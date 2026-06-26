/**
 * compactSession —— 外部手动压缩入口（如 backend /compact）。
 *
 * 与 run 内自动压缩（round.before hook → compressIfNeeded）共享同一执行体
 * （loadHistory → selectSegment → summarizeSegment → insertCompressionMessage），
 * 走 forceCompact（无阈值门控）。busy 守卫不在 SDK——SDK 是 per-run 一次性、不持有跨 run
 * session 状态；调用方（backend）用自己的 active-run 追踪（statusTracker）在调本入口前拦截。
 *
 * provider/modelName 不传——从 profile.llmTiers（fast→default）自取（投影层已算死）。
 * llm 不传时 SDK 内部用 OpenAiCompatibleClient 默认实现（与 createRuntime 一致）。
 */
import { OpenAiCompatibleClient, type LlmClient } from "@ragsystem/agent-llm";
import type { RuntimeStore } from "../contracts.js";
import type { AgentProfile } from "../types.js";
import { AgentContextCompressionService, type CompressInput, type ContextCompressionResult } from "./context-compression.js";

export interface CompactSessionInput {
  sessionId: string;
  store: RuntimeStore;
  profile: AgentProfile;
  /** 可选：测试注入 fake；生产不传，内部 new OpenAiCompatibleClient()。 */
  llm?: LlmClient;
  threadKey?: string | null;
  signal?: AbortSignal;
}

export type CompactSessionResult = ContextCompressionResult;

export async function compactSession(input: CompactSessionInput): Promise<CompactSessionResult> {
  const llm = input.llm ?? new OpenAiCompatibleClient();
  const service = new AgentContextCompressionService({ store: input.store, llm, profile: input.profile });
  const compressInput: CompressInput = {
    sessionId: input.sessionId,
    ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return service.forceCompact(compressInput);
}
