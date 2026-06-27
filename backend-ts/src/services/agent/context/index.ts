import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { MemoryConfig } from "../../../contracts/system-config.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { resolveContextBudget } from "../context-compression/index.js";
import { projectMemory } from "../sdk/projection.js";
import { toSdkMessageInfo } from "../sdk/sdk-store-adapter.js";
import {
  AgentContextBuilder,
  MemoryIndexContextSource,
  RecentMessagesContextSource,
  type AgentContext,
  type AgentContextSource,
  type ConversationHistoryPort,
  type SessionMetadataPort,
} from "@ragsystem/agent-sdk";

/**
 * 上下文门面 —— 仅供 monitoring 调试快照（snapshotContext + 预算估算）。
 *
 * 与 run 路径同源：用 SDK 的 AgentContextBuilder + MemoryIndexContextSource / RecentMessagesContextSource
 * 组装上下文，backend 不再维护平行组装实现。压缩（自动 round.before / 手动 /compact）由 SDK 承担
 * （compressIfNeeded / compactSession），本门面不参与。
 */
export class AgentContextService {
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly systemConfig: SystemConfigService,
    private readonly memoryConfig: MemoryConfig,
    private readonly dataRoot: string,
    private readonly microcompactTtlSeconds?: number,
  ) {}

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null, modelName: string | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig(), modelName);
  }

  /** 只读上下文快照（不压缩），供 monitoring 端点。与 run 的 createRuntime 同源 builder/sources。 */
  snapshotContext(input: {
    sessionId: string;
    agent: AgentConfig;
    provider: ModelProviderConfig | null;
    modelName?: string | null | undefined;
  }): { context: AgentContext; budgetTokens: number } {
    const port = buildSdkPort(this.conversationStore);
    const memory = projectMemory(input.agent);
    const memoryEnabled =
      memory.allowedScopes.length > 0 || memory.writeScopes.length > 0 || memory.archiveScopes.length > 0;
    const sources: AgentContextSource[] = memoryEnabled
      ? [
          new MemoryIndexContextSource(port, memory, input.agent.agent_name, {
            dataRoot: this.dataRoot,
            indexMaxLines: this.memoryConfig.index_max_lines,
            indexMaxChars: this.memoryConfig.index_max_chars,
          }),
          new RecentMessagesContextSource(port),
        ]
      : [new RecentMessagesContextSource(port)];
    const builder = new AgentContextBuilder(
      sources,
      this.microcompactTtlSeconds !== undefined ? { microcompactTtlSeconds: this.microcompactTtlSeconds } : {},
    );
    const context = builder.buildContext({ sessionId: input.sessionId, threadKey: "root" });
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider, input.modelName ?? null);
    return { context, budgetTokens };
  }
}

/**
 * backend ConversationStore → SDK context 端口（history + session metadata 二合一）。
 * RecentMessagesContextSource 据此判定 microcompact 缓存（isSessionMetadataPort 探测）。
 * history 读取处做 backend MessageInfo（snake）→ SDK MessageInfo（camel）映射。
 */
function buildSdkPort(store: ConversationStore): ConversationHistoryPort & SessionMetadataPort {
  return {
    getRecentMessages: (sessionId, limit, threadKey) =>
      store.getRecentMessages(sessionId, limit, threadKey ?? null).map(toSdkMessageInfo),
    getSession: (sessionId) => store.getSession(sessionId),
    updateSessionMetadata: (sessionId, patch) => store.updateSessionMetadata(sessionId, patch),
  };
}
