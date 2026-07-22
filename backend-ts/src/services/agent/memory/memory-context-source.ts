import crypto from "node:crypto";

import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { MemoryCandidateRecord } from "../../../contracts/conversation-store/index.js";
import type { MemoryContextRepository, MemoryScopeSpec } from "../../../contracts/memory-store/index.js";
import type {
  AgentContextContribution,
  AgentContextSource,
  ResolvedAgentContextRequest,
  SessionMetadataPort,
} from "../context/types.js";
import {
  buildMemoryPrefixFingerprint,
  buildMemoryPrefixStructuralFingerprint,
  buildMemoryScopeCapabilities,
  buildMemoryScopeSpecs,
  memoryBaselineKey,
  readMemoryPrefixSnapshot,
  renderMemoryPrefixBlock,
  type MemoryPrefixSnapshot,
} from "./memory-prefix.js";
import type { ExecutionMemoryCandidateListPort } from "./runtime-bindings.js";

type MemoryConfig = AgentConfig["memory"];

export interface MemoryContextSourceOptions {
  indexMaxLines?: number;
  indexMaxChars?: number;
}

/** Shared Memory prefix orchestration for Local and SaaS deployments. */
export class MemoryContextSource implements AgentContextSource {
  readonly name = "memory";
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;

  constructor(
    private readonly sessions: SessionMetadataPort & Partial<ExecutionMemoryCandidateListPort>,
    private readonly repository: MemoryContextRepository,
    private readonly memory: MemoryConfig,
    private readonly agentName: string,
    options: MemoryContextSourceOptions = {},
  ) {
    this.indexMaxLines = options.indexMaxLines ?? 200;
    this.indexMaxChars = options.indexMaxChars ?? 25_600;
  }

  async build(request: ResolvedAgentContextRequest): Promise<AgentContextContribution> {
    const scopeCapabilities = buildMemoryScopeCapabilities(this.memory);
    const memoryEnabled = Boolean(
      scopeCapabilities.allowed_scopes.length
        || scopeCapabilities.write_scopes.length
        || scopeCapabilities.archive_scopes.length,
    );
    if (!memoryEnabled && this.memory.auto_inject === false) {
      return { conversation: [], metadata: { status: "disabled", scope_capabilities: scopeCapabilities } };
    }

    const session = this.sessions.getSession(request.sessionId);
    const sessionMetadata = session?.metadata ?? {};
    const userId = session?.user_id ?? null;
    const scopeSpecs = buildMemoryScopeSpecs({
      memory: this.memory,
      sessionId: request.sessionId,
      agentName: this.agentName,
      sessionMetadata,
      userId,
      workspaceKey: await this.repository.resolveWorkspaceKey(sessionMetadata),
    });
    const structuralFingerprint = buildMemoryPrefixStructuralFingerprint({
      memory: this.memory,
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
      return contribution(existingSnapshot);
    }

    const privateCandidates = this.memory.auto_inject === false
      ? []
      : await this.loadPrivateCandidates(userId, sessionMetadata, scopeCapabilities.allowed_scopes);
    const revisions = await Promise.all(scopeSpecs.map(async (scopeSpec) => ({
      scopeSpec,
      revision: await this.repository.getScopeRevision(scopeSpec),
    })));
    const scopeRevisions = revisions.flatMap(({ scopeSpec, revision }) => revision === null
      ? []
      : [{ scopeSpec, revision: String(revision) }]);
    const fingerprint = buildMemoryPrefixFingerprint({
      memory: this.memory,
      scopeCapabilities,
      scopeSpecs,
      agentName: this.agentName,
      privateCandidateRevision: fingerprintCandidates(privateCandidates),
      ...(scopeRevisions.length ? { scopeRevisions } : {}),
    });
    const indices = await this.loadIndices(scopeSpecs);
    const sharedBlock = renderMemoryPrefixBlock({ scopeCapabilities, indices });
    const renderedBlock = [sharedBlock, renderPrivateMemory(privateCandidates)].filter(Boolean).join("\n\n");
    const snapshot: MemoryPrefixSnapshot = {
      baseline_key: baselineKey,
      session_id: request.sessionId,
      thread_key: request.threadKey,
      agent_name: this.agentName,
      fingerprint,
      scope_capabilities: scopeCapabilities,
      indices,
      rendered_block: renderedBlock,
      rebased_reason: "build_context",
    };
    this.sessions.updateSessionMetadata?.(request.sessionId, {
      memory_prefix_states: { [baselineKey]: snapshot },
    });
    return contribution(snapshot);
  }

  private async loadIndices(scopeSpecs: MemoryScopeSpec[]): Promise<Record<string, string>> {
    if (this.memory.auto_inject === false) return {};
    const loaded = await Promise.all(scopeSpecs.map(async (scopeSpec) => ({
      scope: scopeSpec.scope,
      content: await this.repository.loadIndex(scopeSpec, {
        maxLines: this.indexMaxLines,
        maxChars: this.indexMaxChars,
      }),
    })));
    return Object.fromEntries(loaded.flatMap(({ scope, content }) => content ? [[scope, content]] : []));
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

function contribution(snapshot: MemoryPrefixSnapshot): AgentContextContribution {
  return {
    conversation: snapshot.rendered_block ? [{ role: "system", content: snapshot.rendered_block }] : [],
    metadata: { status: "loaded", snapshot },
  };
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
