import type { IMemoryStore, MemoryScopeSpec } from "../../../contracts/memory-store/index.js";
import { MemoryStore } from "../../stores/memory-store.js";
import type {
  AgentContextContribution,
  AgentContextSource,
  ResolvedAgentContextRequest,
  SessionMetadataPort,
} from "./types.js";
import { DEFAULT_INDEX_MAX_CHARS, DEFAULT_INDEX_MAX_LINES } from "./types.js";
import {
  buildMemoryPrefixFingerprint,
  buildMemoryScopeCapabilities,
  buildMemoryScopeSpecs,
  memoryBaselineKey,
  readMemoryPrefixSnapshot,
  renderMemoryPrefixBlock,
  type MemoryPrefixFingerprint,
  type MemoryPrefixSnapshot,
  type MemoryScopeCapabilities,
} from "./memory.js";

interface MemoryIndexContextSourceOptions {
  dataRoot?: string | undefined;
  memoryStore?: IMemoryStore | undefined;
  indexMaxLines?: number | undefined;
  indexMaxChars?: number | undefined;
}

export class MemoryIndexContextSource implements AgentContextSource {
  readonly name = "memory";
  private readonly memoryStore: IMemoryStore;
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;

  constructor(
    private readonly sessions: SessionMetadataPort,
    options: MemoryIndexContextSourceOptions = {},
  ) {
    this.memoryStore = options.memoryStore ?? new MemoryStore({ dataRoot: options.dataRoot });
    this.indexMaxLines = options.indexMaxLines ?? DEFAULT_INDEX_MAX_LINES;
    this.indexMaxChars = options.indexMaxChars ?? DEFAULT_INDEX_MAX_CHARS;
  }

  build(request: ResolvedAgentContextRequest): AgentContextContribution {
    if (!request.agent) {
      return {
        conversation: [],
        metadata: {
          status: "missing_agent",
        },
      };
    }

    const memoryConfig = request.agent.memory;
    const scopeCapabilities = buildMemoryScopeCapabilities(memoryConfig);
    const memoryEnabled = Boolean(
      scopeCapabilities.allowed_scopes.length ||
        scopeCapabilities.write_scopes.length ||
        scopeCapabilities.archive_scopes.length,
    );
    if (!memoryEnabled && memoryConfig.auto_inject === false) {
      return {
        conversation: [],
        metadata: {
          status: "disabled",
          scope_capabilities: scopeCapabilities,
        },
      };
    }

    const sessionMetadata = this.sessions.getSession(request.sessionId)?.metadata ?? {};
    const scopeSpecs = buildMemoryScopeSpecs({
      memoryConfig,
      sessionId: request.sessionId,
      agentName: request.agent.agent_name,
      sessionMetadata,
    });
    const fingerprint = buildMemoryPrefixFingerprint({
      memoryConfig,
      scopeCapabilities,
      scopeSpecs,
      agentName: request.agent.agent_name,
    });
    const baselineKey = memoryBaselineKey(request.threadKey, request.agent.agent_name);
    const existingSnapshot = readMemoryPrefixSnapshot(sessionMetadata, baselineKey);
    const snapshot =
      !request.forceMemoryPrefixRefresh && existingSnapshot?.fingerprint.fingerprint === fingerprint.fingerprint
        ? existingSnapshot
        : this.buildAndPersistSnapshot({
            request,
            baselineKey,
            fingerprint,
            scopeCapabilities,
            scopeSpecs,
          });
    const renderedBlock = snapshot.rendered_block;
    request.stablePrefixFingerprint = snapshot.fingerprint.fingerprint;

    return {
      conversation: renderedBlock ? [{ role: "system", content: renderedBlock }] : [],
      metadata: {
        status: "loaded",
        snapshot,
      },
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
    if (input.request.agent?.memory.auto_inject !== false) {
      for (const scopeSpec of input.scopeSpecs) {
        const content = this.memoryStore.loadIndexHead(scopeSpec, {
          maxLines: this.indexMaxLines,
          maxChars: this.indexMaxChars,
        });
        if (content) {
          indices[scopeSpec.scope] = content;
        }
      }
    }
    const renderedBlock = renderMemoryPrefixBlock({
      scopeCapabilities: input.scopeCapabilities,
      indices,
    });
    const snapshot: MemoryPrefixSnapshot = {
      baseline_key: input.baselineKey,
      session_id: input.request.sessionId,
      thread_key: input.request.threadKey,
      agent_name: input.request.agent?.agent_name ?? "",
      fingerprint: input.fingerprint,
      scope_capabilities: input.scopeCapabilities,
      indices,
      rendered_block: renderedBlock,
      rebased_reason: input.request.forceMemoryPrefixRefresh ? "forced_refresh" : "build_context",
    };
    this.sessions.updateSessionMetadata?.(input.request.sessionId, {
      memory_prefix_states: {
        [input.baselineKey]: snapshot,
      },
    });
    return snapshot;
  }
}
