import type { AgentProfile } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import { AgentContextBuilder } from "./context-builder.js";
import { createDefaultProjectionRegistry } from "./extensions/index.js";
import { DEFAULT_PROVIDER_CACHE_TTL_SECONDS, ProviderCacheTracker } from "./provider-cache-tracker.js";
import { RecentMessagesContextSource } from "./recent-messages-source.js";
import type { ConversationHistoryPort, SessionMetadataPort } from "./types.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";

export interface BuildBackendAgentContextOptions {
  dataRoot: string;
  sessionId: string;
  threadKey?: string | null;
  touch?: boolean;
  sessionFiles?: SessionFileLookupPort | null;
  /** 本次 run 实际使用的 provider/model（含 selectedLlm 覆盖）；continuation 恢复的印章门控依据。 */
  providerIdentity?: { providerKey: string; model: string } | null;
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
  const contextBuilder = new AgentContextBuilder([recentSource], cacheTracker);
  const request = {
    sessionId: options.sessionId,
    threadKey: options.threadKey ?? "root",
  };
  const built = options.touch === undefined
    ? await contextBuilder.buildContext(request)
    : await contextBuilder.buildContext(request, { touch: options.touch });

  return { built, contextBuilder, recentSource, cacheTracker };
}
