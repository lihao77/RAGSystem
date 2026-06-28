/**
 * MemoryIndexContextSource——memory context source（实现 SDK AgentContextSource）。
 * 按 agent.memory 配置加载 scope 前缀 + 指纹缓存（写 session metadata），产出 system 消息注入 prompt。
 * 迿自 SDK memory 模块，归位 backend；字段对齐 AgentConfig.memory（snake）。
 * 经 createRuntime({ extraContextSources: [memorySource] }) 注入，SDK 不再内置 memory。
 */
import type { IMemoryStore, MemoryScopeSpec, MemoryStoreOptions } from "../../../contracts/memory-store/index.js";
import { MemoryStore } from "../../stores/memory-store.js";
import type { AgentContextContribution, AgentContextSource, ResolvedAgentContextRequest, SessionMetadataPort } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../../contracts/agent-config.js";
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
} from "./memory-prefix.js";

type MemoryConfig = AgentConfig["memory"];

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
    private readonly memory: MemoryConfig,
    private readonly agentName: string,
    options: MemoryIndexContextSourceOptions = {},
  ) {
    const storeOptions: MemoryStoreOptions = {};
    if (options.dataRoot) { storeOptions.dataRoot = options.dataRoot; }
    this.memoryStore = options.memoryStore ?? new MemoryStore(storeOptions);
    this.indexMaxLines = options.indexMaxLines ?? 200;
    this.indexMaxChars = options.indexMaxChars ?? 25600;
  }

  build(request: ResolvedAgentContextRequest): AgentContextContribution {
    const memory = this.memory;
    const scopeCapabilities = buildMemoryScopeCapabilities(memory);
    const memoryEnabled = Boolean(
      scopeCapabilities.allowed_scopes.length ||
        scopeCapabilities.write_scopes.length ||
        scopeCapabilities.archive_scopes.length,
    );
    if (!memoryEnabled && memory.auto_inject === false) {
      return { conversation: [], metadata: { status: "disabled", scope_capabilities: scopeCapabilities } };
    }
    const sessionMetadata = this.sessions.getSession(request.sessionId)?.metadata ?? {};
    const scopeSpecs = buildMemoryScopeSpecs({
      memory,
      sessionId: request.sessionId,
      agentName: this.agentName,
      sessionMetadata,
    });
    const fingerprint = buildMemoryPrefixFingerprint({
      memory,
      scopeCapabilities,
      scopeSpecs,
      agentName: this.agentName,
    });
    const baselineKey = memoryBaselineKey(request.threadKey, this.agentName);
    const existingSnapshot = readMemoryPrefixSnapshot(sessionMetadata, baselineKey);
    const snapshot =
      existingSnapshot?.fingerprint.fingerprint === fingerprint.fingerprint
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
    if (this.memory.auto_inject !== false) {
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
      agent_name: this.agentName,
      fingerprint: input.fingerprint,
      scope_capabilities: input.scopeCapabilities,
      indices,
      rendered_block: renderedBlock,
      rebased_reason: "build_context",
    };
    this.sessions.updateSessionMetadata?.(input.request.sessionId, { memory_prefix_states: { [input.baselineKey]: snapshot } });
    return snapshot;
  }
}
