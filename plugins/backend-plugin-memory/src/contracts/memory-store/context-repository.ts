import type { MemoryScopeSpec } from "./types.js";

/** Promise-only Memory prefix read model implemented by deployment adapters. */
export interface MemoryContextRepository {
  resolveWorkspaceKey(workspaceId: string | null): Promise<string | null>;
  loadIndex(
    scopeSpec: MemoryScopeSpec,
    limits: { maxLines: number; maxChars: number },
  ): Promise<string>;
  getScopeRevision(scopeSpec: MemoryScopeSpec): Promise<string | number | null>;
}
