import type { AgentProfile } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { MemoryConfig } from "../../../contracts/runtime/system-config.js";
import { isMemoryEnabled } from "../memory/index.js";
import { AgentContextBuilder } from "./context-builder.js";
import { createDefaultProjectionRegistry } from "./extensions/index.js";
import { DEFAULT_PROVIDER_CACHE_TTL_SECONDS, ProviderCacheTracker } from "./provider-cache-tracker.js";
import { RecentMessagesContextSource } from "./recent-messages-source.js";
import type { ConversationHistoryPort, SessionMetadataPort } from "./types.js";
import type { ExecutionMemoryCandidateListPort, MemoryRuntimeBindings } from "../memory/runtime-bindings.js";

export interface BuildBackendAgentContextOptions {
  memoryConfig: MemoryConfig;
  dataRoot: string;
  sessionId: string;
  threadKey?: string | null;
  touch?: boolean;
  memoryContextSourceFactory?: MemoryRuntimeBindings["createContextSource"];
}

export async function buildBackendAgentContext(
  agent: AgentConfig,
  profile: AgentProfile,
  historyPort: ConversationHistoryPort & SessionMetadataPort & Partial<ExecutionMemoryCandidateListPort>,
  options: BuildBackendAgentContextOptions,
) {
  const memorySources = isMemoryEnabled(agent.memory)
    ? [options.memoryContextSourceFactory
        ? options.memoryContextSourceFactory({
            sessions: historyPort,
            memory: agent.memory,
            agentName: agent.agent_name,
            memoryConfig: options.memoryConfig,
            dataRoot: options.dataRoot,
          })
        : (() => { throw new Error("Memory context source factory is required for the selected runtime"); })()]
    : [];
  const extensionRegistry = createDefaultProjectionRegistry();
  const recentSource = new RecentMessagesContextSource(
    historyPort,
    profile.llmTiers.default?.provider.supports_vision === true,
    extensionRegistry,
  );
  const cacheTracker = new ProviderCacheTracker(
    historyPort,
    profile.llmTiers.default?.provider.cache_ttl_seconds ?? DEFAULT_PROVIDER_CACHE_TTL_SECONDS,
  );
  const contextBuilder = new AgentContextBuilder([...memorySources, recentSource], cacheTracker);
  const request = {
    sessionId: options.sessionId,
    threadKey: options.threadKey ?? "root",
    microcompact: true,
  };
  const built = options.touch === undefined
    ? await contextBuilder.buildContext(request)
    : await contextBuilder.buildContext(request, { touch: options.touch });

  return { built, contextBuilder, memorySources, recentSource, cacheTracker };
}
