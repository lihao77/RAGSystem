import type { MemoryContextRepository, MemoryScopeSpec } from "../../contracts/memory-store/index.js";
import { getWorkspaceMemoryKey } from "../../contracts/memory-store/index.js";
import type { MemoryStore } from "./memory-store.js";

/** Adapts the synchronous filesystem index API to the shared asynchronous context port. */
export class LocalMemoryContextRepository implements MemoryContextRepository {
  constructor(private readonly memory: Pick<MemoryStore, "loadIndexHead">) {}

  async resolveWorkspaceKey(sessionMetadata: Record<string, unknown>): Promise<string | null> {
    const workspaceRoot = sessionMetadata.workspace_root;
    return getWorkspaceMemoryKey(typeof workspaceRoot === "string" ? workspaceRoot : null);
  }

  async loadIndex(
    scopeSpec: MemoryScopeSpec,
    limits: { maxLines: number; maxChars: number },
  ): Promise<string> {
    return this.memory.loadIndexHead(scopeSpec, limits);
  }

  async getScopeRevision(_scopeSpec: MemoryScopeSpec): Promise<null> {
    return null;
  }
}
