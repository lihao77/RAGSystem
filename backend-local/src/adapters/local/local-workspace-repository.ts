import type { WorkspaceRepositoryPort } from "@ragsystem/backend-core/contracts/workspace/workspace-repository.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

export class LocalWorkspaceRepository implements WorkspaceRepositoryPort {
  constructor(private readonly store: ConversationStore) {}
  async resolveLocal(input: Parameters<WorkspaceRepositoryPort["resolveLocal"]>[0]) { return this.store.resolveLocalWorkspace(input); }
  async getById(tenantId: Parameters<WorkspaceRepositoryPort["getById"]>[0], workspaceId: string) { return this.store.getWorkspaceById(tenantId, workspaceId); }
  async getByCanonicalKey(tenantId: Parameters<WorkspaceRepositoryPort["getByCanonicalKey"]>[0], canonicalKey: string) { return this.store.getWorkspaceByCanonicalKey(tenantId, canonicalKey); }
  async listByIds(tenantId: Parameters<WorkspaceRepositoryPort["listByIds"]>[0], workspaceIds: readonly string[]) { return this.store.listWorkspacesByIds(tenantId, workspaceIds); }
  async updateLocalPath(input: Parameters<WorkspaceRepositoryPort["updateLocalPath"]>[0]) { return this.store.updateLocalWorkspacePath(input); }
}
