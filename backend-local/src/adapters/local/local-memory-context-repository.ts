import type { MemoryContextRepository, MemoryScopeSpec } from "@ragsystem/backend-core/contracts/memory-store/index.js";
import { getWorkspaceMemoryKey } from "@ragsystem/backend-core/contracts/memory-store/index.js";
import type { MemoryStore } from "./memory-store.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

/** Adapts the synchronous filesystem index API to the shared asynchronous context port. */
export class LocalMemoryContextRepository implements MemoryContextRepository {
  constructor(
    private readonly memory: Pick<MemoryStore, "loadIndexHead">,
    private readonly workspaces?: { tenantId: TenantId; store: Pick<ConversationStore, "getWorkspaceById"> },
  ) {}

  async resolveWorkspaceKey(workspaceId: string | null): Promise<string | null> {
    if (!workspaceId || !this.workspaces) return null;
    const workspace = this.workspaces.store.getWorkspaceById(this.workspaces.tenantId, workspaceId);
    return getWorkspaceMemoryKey(workspace?.canonical_key ?? null);
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
