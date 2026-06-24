/**
 * MemoryIndexContextSource（迁自 backend-ts，profile 经构造注入——request 不再带 agent）。
 * 按 profile.memory 加载 scope 前缀 + 指纹缓存（写 session metadata）。
 */
import type { IMemoryStore, MemoryScopeSpec } from "./types.js";
import { MemoryStore } from "./memory-store.js";
import type { AgentContextContribution, AgentContextSource, ResolvedAgentContextRequest, SessionMetadataPort } from "../context/types.js";
import type { AgentProfile } from "../types.js";
import { buildMemoryPrefixFingerprint } from "./memory-prefix.js";
import { buildMemoryScopeCapabilities } from "./memory-prefix.js";
import { buildMemoryScopeSpecs } from "./memory-prefix.js";
import { memoryBaselineKey } from "./memory-prefix.js";
import { readMemoryPrefixSnapshot } from "./memory-prefix.js";
import { renderMemoryPrefixBlock } from "./memory-prefix.js";
import type { MemoryPrefixFingerprint } from "./memory-prefix.js";
import type { MemoryPrefixSnapshot } from "./memory-prefix.js";
import type { MemoryScopeCapabilities } from "./memory-prefix.js";

export interface MemoryIndexContextSourceOptions {
  dataRoot?: string;
  memoryStore?: IMemoryStore;
  indexMaxLines?: number;
  indexMaxChars?: number;
}

export class MemoryIndexContextSource implements AgentContextSource {
  readonly name = "memory";
  private readonly memoryStore: IMemoryStore;
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;

  constructor(
    private readonly sessions: SessionMetadataPort,
    private readonly profile: AgentProfile,
   options: MemoryIndexContextSourceOptions = {},
 ) {
    const storeOptions: import("./types.js").MemoryStoreOptions = {};
    if (options.dataRoot) { storeOptions.dataRoot = options.dataRoot; }
    this.memoryStore = options.memoryStore ?? new MemoryStore(storeOptions);
   this.indexMaxLines = options.indexMaxLines ?? 200;
    this.indexMaxChars = options.indexMaxChars ?? 25600;
  }

  build(request: ResolvedAgentContextRequest): AgentContextContribution {
    const memoryConfig = this.profile.memory;
    const scopeCapabilities = buildMemoryScopeCapabilities(memoryConfig);
    const memoryEnabled = Boolean(
      scopeCapabilities.allowed_scopes.length ||
        scopeCapabilities.write_scopes.length ||
        scopeCapabilities.archive_scopes.length,
    );
    if (!memoryEnabled && memoryConfig.autoInject === false) {
      return { conversation: [], metadata: { status: "disabled", scope_capabilities: scopeCapabilities } };
    }
    const sessionMetadata = this.sessions.getSession(request.sessionId)?.metadata ?? {};
    const scopeSpecs = buildMemoryScopeSpecs({
      memoryConfig,
      sessionId: request.sessionId,
      agentName: this.profile.agentName,
      sessionMetadata,
    });
    const fingerprint = buildMemoryPrefixFingerprint({
      memoryConfig,
      scopeCapabilities,
      scopeSpecs,
      agentName: this.profile.agentName,
    });
    const baselineKey = memoryBaselineKey(request.threadKey, this.profile.agentName);
    const existingSnapshot = readMemoryPrefixSnapshot(sessionMetadata, baselineKey);
    const snapshot =
      !request.forceMemoryPrefixRefresh && existingSnapshot?.fingerprint.fingerprint === fingerprint.fingerprint
        ? existingSnapshot
        : this.buildAndPersistSnapshot({ request, baselineKey, fingerprint, scopeCapabilities, scopeSpecs });
    const renderedBlock = snapshot.rendered_block;
    request.stablePrefixFingerprint = snapshot.fingerprint.fingerprint;
    return {
      conversation: renderedBlock ? [{ role: "system", content: renderedBlock }] : [],
      metadata: { status: "loaded", snapshot },
    };
  }

  private buildAndPersistSnapshot(input: {
    request: ResolvedAgentContextRequest;
    baselineKey: string;
    fingerprint: MemoryPrefixFingerprint;
    scopeCapabilities: MemoryScopeCapabilities;
    scopeSpecs: MemoryScopeSpec[];
  }): MemoryPrefixSnapshot {
    const indices: Record<string, string> = {};
    if (this.profile.memory.autoInject !== false) {
      for (const scopeSpec of input.scopeSpecs) {
        const content = this.memoryStore.loadIndexHead(scopeSpec, { maxLines: this.indexMaxLines, maxChars: this.indexMaxChars });
        if (content) { indices[scopeSpec.scope] = content; }
      }
    }
    const renderedBlock = renderMemoryPrefixBlock({ scopeCapabilities: input.scopeCapabilities, indices });
    const snapshot: MemoryPrefixSnapshot = {
      baseline_key: input.baselineKey,
      session_id: input.request.sessionId,
      thread_key: input.request.threadKey,
      agent_name: this.profile.agentName,
      fingerprint: input.fingerprint,
      scope_capabilities: input.scopeCapabilities,
      indices,
      rendered_block: renderedBlock,
      rebased_reason: input.request.forceMemoryPrefixRefresh ? "forced_refresh" : "build_context",
    };
    this.sessions.updateSessionMetadata?.(input.request.sessionId, { memory_prefix_states: { [input.baselineKey]: snapshot } });
    return snapshot;
  }
}
