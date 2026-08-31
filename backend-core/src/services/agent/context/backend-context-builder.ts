import type { AgentProfile } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { SessionIdentity } from "../../../contracts/session/session.js";
import type { BackendContextSourceFactory } from "../../../plugins/backend-plugin.js";
import { AgentContextBuilder } from "./context-builder.js";
import { createDefaultProjectionRegistry } from "./extensions/index.js";
import { DEFAULT_PROVIDER_CACHE_TTL_SECONDS, ProviderCacheTracker } from "./provider-cache-tracker.js";
import { RecentMessagesContextSource } from "./recent-messages-source.js";
import type { AgentContextSource, ConversationHistoryPort, SessionMetadataPort } from "./types.js";
import { DEFAULT_THREAD_KEY } from "./types.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";

export interface BuildBackendAgentContextOptions {
  dataRoot: string;
  sessionId: string;
  threadKey?: string | null;
  touch?: boolean;
  sessionFiles?: SessionFileLookupPort | null;
  /** 本次 run 实际使用的 provider/model（含 selectedLlm 覆盖）；continuation 恢复的印章门控依据。 */
  providerIdentity?: { providerKey: string; model: string } | null;
  /** 会话身份快照（前置 source 工厂入参；插件据此解析 team/agent 配置）。缺失时跳过前置工厂。 */
  sessionIdentity?: SessionIdentity | null;
  /** 插件贡献的前置 source 工厂：实例化结果排在 recentSource 之前（history 前的稳定前缀）。 */
  frontContextSources?: readonly BackendContextSourceFactory[];
}

export async function buildBackendAgentContext(
  agent: AgentConfig,
  profile: AgentProfile,
  historyPort: ConversationHistoryPort & SessionMetadataPort,
  options: BuildBackendAgentContextOptions,
) {
  const extensionRegistry = createDefaultProjectionRegistry();
  const recentSource = new RecentMessagesContextSource(
    historyPort,
    profile.llmTiers.default?.provider.supports_vision === true,
    extensionRegistry,
    options.sessionFiles ?? null,
    options.providerIdentity ?? null,
  );
  const cacheTracker = new ProviderCacheTracker(
    historyPort,
    profile.llmTiers.default?.provider.cache_ttl_seconds ?? DEFAULT_PROVIDER_CACHE_TTL_SECONDS,
  );
  // 插件贡献的前置 source 先实例化（null = 本组装不贡献），再与 recent 组装：
  // 前置在 history 之前进入稳定前缀，provider 前缀缓存可命中；快照冻结/重建由 source
  // 依 request.cacheAlive（ProviderCacheTracker 真实活性）与 request.touch（是否允许写副作用）自行决策。
  const sessionIdentity = options.sessionIdentity ?? null;
  const threadKey = options.threadKey?.trim() || DEFAULT_THREAD_KEY;
  const frontSources = sessionIdentity
    ? (await Promise.all(
      (options.frontContextSources ?? []).map((factory) => factory({
        agent,
        profile,
        sessionIdentity,
        sessions: historyPort,
        threadKey,
        dataRoot: options.dataRoot,
      })),
    )).filter((source): source is AgentContextSource => source !== null)
    : [];
  const contextBuilder = new AgentContextBuilder([...frontSources, recentSource], cacheTracker);
  const request = {
    sessionId: options.sessionId,
    threadKey,
  };
  const built = options.touch === undefined
    ? await contextBuilder.buildContext(request)
    : await contextBuilder.buildContext(request, { touch: options.touch });

  return { built, contextBuilder, recentSource, cacheTracker };
}
