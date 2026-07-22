/**
 * MemoryIndexContextSource——memory context source（实现 backend AgentContextSource）。
 * 按 agent.memory 配置加载 scope 前缀 + 指纹缓存（写 session metadata），产出 system 消息注入 prompt。
 *
 * 前缀快照的命中/重建由 provider cache 活性驱动（request.cacheAlive，由 buildContext 据
 * ProviderCacheTracker 统一设）：cache 活 → 复用 rendered_block（前缀字面稳定，命中 KV cache）；
 * cache 死或结构指纹变 → 重建读最新 memory store。内容 revision 在 cache 世代内不触发重建；
 * last_used_at 的存储/续期由 ProviderCacheTracker 统一管，
 * 本 source 不自管时间戳（失效/续期信号经 request.cacheAlive 接入，与 recent 等子系统共用同一信号）。
 *
 * 迿自 SDK memory 模块，归位 backend；字段对齐 AgentConfig.memory（snake）。
 * 由 backend AgentContextBuilder 组装（memory + recent）→ conversation 经 RunInput.conversation 注入 SDK。
 */
import crypto from "node:crypto";

import type {
  MemoryIndexReader,
  MemoryScopeRevisionReader,
  MemoryScopeSpec,
} from "../../../contracts/memory-store/index.js";
import type { AgentContextContribution, AgentContextSource, ResolvedAgentContextRequest, SessionMetadataPort } from "../context/types.js";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { MemoryCandidateRecord } from "../../../contracts/conversation-store/index.js";
import type { ExecutionMemoryCandidateListPort } from "./runtime-bindings.js";
import {
  buildMemoryPrefixFingerprint,
  buildMemoryPrefixStructuralFingerprint,
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
  memoryRepository?: MemoryIndexReader;
  /** @deprecated Use memoryRepository. */
  memoryStore?: MemoryIndexReader;
  scopeRevisionReader?: MemoryScopeRevisionReader;
  indexMaxLines?: number;
  indexMaxChars?: number;
}

export class MemoryIndexContextSource implements AgentContextSource {
  readonly name = "memory";
  private readonly memoryStore: MemoryIndexReader;
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;
  private readonly scopeRevisionReader: MemoryScopeRevisionReader | undefined;

  constructor(
    private readonly sessions: SessionMetadataPort & Partial<ExecutionMemoryCandidateListPort>,
    private readonly memory: MemoryConfig,
    private readonly agentName: string,
    options: MemoryIndexContextSourceOptions = {},
  ) {
    const memoryRepository = options.memoryStore ?? options.memoryRepository;
    if (!memoryRepository) {
      throw new Error("MemoryIndexContextSource requires a memoryRepository");
    }
    this.memoryStore = memoryRepository;
    this.scopeRevisionReader = options.scopeRevisionReader;
    this.indexMaxLines = options.indexMaxLines ?? 200;
    this.indexMaxChars = options.indexMaxChars ?? 25600;
  }

  async build(request: ResolvedAgentContextRequest): Promise<AgentContextContribution> {
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
    const session = this.sessions.getSession(request.sessionId);
    const sessionMetadata = session?.metadata ?? {};
    const userId = session?.user_id ?? null;
    const scopeSpecs = buildMemoryScopeSpecs({
      memory,
      sessionId: request.sessionId,
      agentName: this.agentName,
      sessionMetadata,
      userId,
    });
    const structuralFingerprint = buildMemoryPrefixStructuralFingerprint({
      memory,
      scopeCapabilities,
      scopeSpecs,
      agentName: this.agentName,
    });
    const baselineKey = memoryBaselineKey(request.threadKey, this.agentName);
    const existingSnapshot = readMemoryPrefixSnapshot(sessionMetadata, baselineKey);
    // Mutable memory revisions do not end a provider-cache epoch. Tool messages carry
    // in-epoch mutations; an expired cache or a structural change rebases the full block.
    if (existingSnapshot
      && existingSnapshot.fingerprint.structural_fingerprint === structuralFingerprint
      && request.cacheAlive) {
      return {
        conversation: existingSnapshot.rendered_block ? [{ role: "system", content: existingSnapshot.rendered_block }] : [],
        metadata: { status: "loaded", snapshot: existingSnapshot },
      };
    }
    const privateCandidates = memory.auto_inject === false
      ? []
      : await this.loadPrivateCandidates(userId, sessionMetadata, scopeCapabilities.allowed_scopes);
    const revisionReader = this.scopeRevisionReader;
    const scopeRevisions = revisionReader
      ? scopeSpecs.map((scopeSpec) => ({ scopeSpec, revision: String(revisionReader.getScopeRevision(scopeSpec)) }))
      : undefined;
    const fingerprint = buildMemoryPrefixFingerprint({
      memory,
      scopeCapabilities,
      scopeSpecs,
      agentName: this.agentName,
      privateCandidateRevision: fingerprintCandidates(privateCandidates),
      ...(scopeRevisions ? { scopeRevisions } : {}),
    });
    const snapshot = this.buildAndPersistSnapshot({ request, baselineKey, fingerprint, scopeCapabilities, scopeSpecs, privateCandidates });
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
    privateCandidates: MemoryCandidateRecord[];
  }): MemoryPrefixSnapshot {
    const indices: Record<string, string> = {};
    if (this.memory.auto_inject !== false) {
      for (const scopeSpec of input.scopeSpecs) {
        const content = this.memoryStore.loadIndexHead(scopeSpec, { maxLines: this.indexMaxLines, maxChars: this.indexMaxChars });
        if (content) { indices[scopeSpec.scope] = content; }
      }
    }
    const sharedBlock = renderMemoryPrefixBlock({ scopeCapabilities: input.scopeCapabilities, indices });
    const privateBlock = renderPrivateMemory(input.privateCandidates);
    const renderedBlock = [sharedBlock, privateBlock].filter(Boolean).join("\n\n");
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

  private async loadPrivateCandidates(
    userId: string | null,
    sessionMetadata: Record<string, unknown>,
    allowedScopes: string[],
  ): Promise<MemoryCandidateRecord[]> {
    if (!userId || !this.sessions.listMemoryCandidates) return [];
    const teamName = typeof sessionMetadata.team === "string" ? sessionMetadata.team.trim() : "";
    if (!teamName) return [];
    const records: MemoryCandidateRecord[] = [];
    if (allowedScopes.includes("agent")) {
      records.push(...await this.sessions.listMemoryCandidates({
        ownerUserId: userId,
        statuses: ["candidate"],
        targetScope: "agent",
        operation: "publish",
        teamName,
        agentName: this.agentName,
        limit: 60,
        contentMaxChars: 4_000,
      }));
    }
    if (allowedScopes.includes("team")) {
      records.push(...await this.sessions.listMemoryCandidates({
        ownerUserId: userId,
        statuses: ["candidate"],
        targetScope: "team",
        operation: "publish",
        teamName,
        limit: 60,
        contentMaxChars: 4_000,
      }));
    }
    return records
      .sort((left, right) => {
        const scopePriority = Number(right.target_scope === "agent") - Number(left.target_scope === "agent");
        return scopePriority || right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id);
      })
      .slice(0, 100);
  }
}

function fingerprintCandidates(candidates: MemoryCandidateRecord[]): string {
  const hash = crypto.createHash("sha256");
  for (const candidate of candidates) {
    hash.update(JSON.stringify([
      candidate.id,
      candidate.updated_at,
      candidate.name,
      candidate.description,
      candidate.content,
      candidate.why,
      candidate.how_to_apply,
    ]));
  }
  return hash.digest("hex").slice(0, 24);
}

function renderPrivateMemory(candidates: MemoryCandidateRecord[]): string {
  if (!candidates.length) return "";
  const lines = ["# Personal Agent Memory", "", "以下记忆仅对当前用户生效，不代表团队共识。"];
  for (const candidate of candidates) {
    lines.push("", `## ${candidate.name}`, candidate.description, "", candidate.content);
  }
  return lines.join("\n").slice(0, 25_600).trim();
}
