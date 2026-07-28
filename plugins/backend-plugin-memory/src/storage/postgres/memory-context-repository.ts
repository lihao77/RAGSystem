import type { MemoryContextRepository, PersistedMemoryEntry, MemoryScopeSpec } from "../../contracts/memory-store/index.js";
import type { MemoryQueryService } from "../../services/memory/query-service.js";
import { toMemoryScopePartition } from "../../services/memory/scope-partition.js";

/** Database-backed implementation of the shared Memory context repository. */
export class SaaSMemoryContextRepository implements MemoryContextRepository {
  constructor(private readonly query: MemoryQueryService) {}

  async resolveWorkspaceKey(workspaceId: string | null): Promise<string | null> {
    return workspaceId?.trim() || null;
  }

  async loadIndex(
    scopeSpec: MemoryScopeSpec,
    limits: { maxLines: number; maxChars: number },
  ): Promise<string> {
    const partition = toMemoryScopePartition(scopeSpec);
    if (!partition) return "";
    const entries = await this.query.listEntries(partition, { limit: limits.maxLines });
    return renderPersistedMemoryIndex(entries, limits);
  }

  async getScopeRevision(scopeSpec: MemoryScopeSpec): Promise<number | null> {
    const partition = toMemoryScopePartition(scopeSpec);
    return partition ? this.query.getScopeRevision(partition) : null;
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
