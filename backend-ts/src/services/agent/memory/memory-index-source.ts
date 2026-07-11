/**
 * MemoryIndexContextSource——memory context source（实现 backend AgentContextSource）。
 * 按 agent.memory 配置加载 scope 前缀 + 指纹缓存（写 session metadata），产出 system 消息注入 prompt。
 *
 * 前缀快照的命中/重建由 provider cache 活性驱动（request.cacheAlive，由 buildContext 据
 * ProviderCacheTracker 统一设）：cache 活 → 复用 rendered_block（前缀字面稳定，命中 KV cache）；
 * cache 死或指纹变 → 重建读最新 memory store。last_used_at 的存储/续期由 ProviderCacheTracker 统一管，
 * 本 source 不自管时间戳（失效/续期信号经 request.cacheAlive 接入，与 recent 等子系统共用同一信号）。
 *
 * 迿自 SDK memory 模块，归位 backend；字段对齐 AgentConfig.memory（snake）。
 * 由 backend AgentContextBuilder 组装（memory + recent）→ conversation 经 RunInput.conversation 注入 SDK。
 */
import type { IMemoryStore, MemoryScopeSpec, MemoryStoreOptions } from "../../../contracts/memory-store/index.js";
import { MemoryStore } from "../../stores/memory-store.js";
import type { AgentContextContribution, AgentContextSource, ResolvedAgentContextRequest, SessionMetadataPort } from "../context/types.js";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { MemoryConfig as SystemMemoryConfig } from "../../../contracts/system-config.js";
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

export function buildMemoryIndexContextSourceOptions(
  memoryConfig: SystemMemoryConfig,
  dataRoot: string,
): MemoryIndexContextSourceOptions {
  return {
    dataRoot,
    indexMaxLines: memoryConfig.index_max_lines,
    indexMaxChars: memoryConfig.index_max_chars,
  };
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
    const fingerprintMatch = existingSnapshot?.fingerprint.fingerprint === fingerprint.fingerprint;
    // 命中(复用 rendered_block)= 指纹匹配 AND provider cache 活(request.cacheAlive,buildContext 据 Tracker 设)。
    // cache 活 → 前缀字面稳定有意义,复用;cache 死或指纹变 → 重建读最新 memory store。
    const snapshot =
      existingSnapshot && fingerprintMatch && request.cacheAlive
        ? existingSnapshot
        : this.buildAndPersistSnapshot({ request, baselineKey, fingerprint, scopeCapabilities, scopeSpecs });
    const renderedBlock = snapshot.rendered_block;
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
