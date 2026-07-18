import type { PersistedMemoryEntry } from "../../../contracts/memory-store/index.js";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { MemoryQueryService } from "../../memory/query-service.js";
import { toMemoryScopePartition } from "../../memory/scope-partition.js";
import type { MemoryScopePartition } from "../../memory/types.js";
import type {
  AgentContextContribution,
  AgentContextSource,
  ResolvedAgentContextRequest,
  SessionMetadataPort,
} from "../context/types.js";
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

export interface SaaSMemoryContextSourceOptions {
  indexMaxLines?: number;
  indexMaxChars?: number;
}

interface ResolvedScope {
  scopeSpec: Parameters<typeof toMemoryScopePartition>[0];
  partition: MemoryScopePartition;
}

/** Database-backed memory context source. It never exposes local paths or file names. */
export class SaaSMemoryContextSource implements AgentContextSource {
  readonly name = "memory";
  private readonly indexMaxLines: number;
  private readonly indexMaxChars: number;

  constructor(
    private readonly sessions: SessionMetadataPort,
    private readonly query: MemoryQueryService,
    private readonly memory: MemoryConfig,
    private readonly agentName: string,
    options: SaaSMemoryContextSourceOptions = {},
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
    const scopeSpecs = buildMemoryScopeSpecs({
      memory: this.memory,
      sessionId: request.sessionId,
      agentName: this.agentName,
      sessionMetadata,
      userId: session?.user_id ?? null,
      workspaceKey: sessionWorkspaceId(sessionMetadata),
    });
    const scopes: ResolvedScope[] = scopeSpecs.flatMap((scopeSpec) => {
      const partition = toMemoryScopePartition(scopeSpec);
      return partition ? [{ scopeSpec, partition }] : [];
    });
    const scopeRevisions = await Promise.all(scopes.map(async ({ scopeSpec, partition }) => ({
      scopeSpec,
      revision: String(await this.query.getScopeRevision(partition)),
    })));
    const fingerprint = buildMemoryPrefixFingerprint({
      memory: this.memory,
      scopeCapabilities,
      scopeSpecs,
      agentName: this.agentName,
      scopeRevisions,
    });
    const baselineKey = memoryBaselineKey(request.threadKey, this.agentName);
    const existingSnapshot = readMemoryPrefixSnapshot(sessionMetadata, baselineKey);
    const snapshot = existingSnapshot
      && existingSnapshot.fingerprint.fingerprint === fingerprint.fingerprint
      && request.cacheAlive
      ? existingSnapshot
      : await this.buildAndPersistSnapshot({ request, baselineKey, fingerprint, scopeCapabilities, scopes });

    return {
      conversation: snapshot.rendered_block
        ? [{ role: "system", content: snapshot.rendered_block }]
        : [],
      metadata: { status: "loaded", snapshot },
    };
  }

  private async buildAndPersistSnapshot(input: {
    request: ResolvedAgentContextRequest;
    baselineKey: string;
    fingerprint: MemoryPrefixFingerprint;
    scopeCapabilities: MemoryScopeCapabilities;
    scopes: ResolvedScope[];
  }): Promise<MemoryPrefixSnapshot> {
    const indices: Record<string, string> = {};
    if (this.memory.auto_inject !== false) {
      const resolvedIndices = await Promise.all(input.scopes.map(async ({ scopeSpec, partition }) => {
        const entries = await this.query.listEntries(partition, { limit: this.indexMaxLines });
        const index = renderPersistedMemoryIndex(entries, {
          maxLines: this.indexMaxLines,
          maxChars: this.indexMaxChars,
        });
        return { scope: scopeSpec.scope, index };
      }));
      for (const { scope, index } of resolvedIndices) {
        if (index) indices[scope] = index;
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
    this.sessions.updateSessionMetadata?.(input.request.sessionId, {
      memory_prefix_states: { [input.baselineKey]: snapshot },
    });
    return snapshot;
  }
}

export function renderPersistedMemoryIndex(
  entries: PersistedMemoryEntry[],
  limits: { maxLines: number; maxChars: number },
): string {
  const lines = entries.slice(0, Math.max(0, limits.maxLines)).map((entry) => {
    const name = oneLine(entry.name);
    const type = oneLine(entry.memory_type);
    const description = oneLine(entry.description);
    return `- ${name} (memory_id: ${entry.id}, type: ${type}): ${description}`;
  });
  return lines.join("\n").slice(0, Math.max(0, limits.maxChars)).trim();
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sessionWorkspaceId(metadata: Record<string, unknown>): string | null {
  for (const key of ["workspace_id", "workspace_key"] as const) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
