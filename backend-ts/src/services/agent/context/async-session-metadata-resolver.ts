import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { SessionInfo } from "../../../contracts/session.js";
import type { SessionMetadataPort } from "./types.js";

export interface AsyncSessionMetadataRepository {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

export interface ResolvedSessionMetadataPort extends SessionMetadataPort {
  flush(): Promise<void>;
}

/**
 * Resolves one execution's session metadata before context assembly. The context
 * sources keep their synchronous Local contract while SaaS writes are awaited at
 * explicit build boundaries through flush().
 */
export async function resolveSessionMetadataPort(
  sessionId: string,
  local: Pick<ConversationStore, "getSession" | "updateSessionMetadata"> | null,
  asyncRepository?: AsyncSessionMetadataRepository,
): Promise<ResolvedSessionMetadataPort> {
  if (!asyncRepository) {
    if (!local) throw new Error("local session metadata storage is required");
    return {
      getSession: (id) => local.getSession(id),
      updateSessionMetadata: (id, patch) => local.updateSessionMetadata(id, patch),
      flush: async () => undefined,
    };
  }

  let current = await asyncRepository.getSession(sessionId);
  let pending = Promise.resolve();
  return {
    getSession: (id) => id === sessionId && current
      ? { metadata: current.metadata ?? {}, user_id: current.user_id }
      : null,
    updateSessionMetadata: (id, patch) => {
      if (id !== sessionId || !current) return null;
      current = { ...current, metadata: mergeMetadata(current.metadata ?? {}, patch) };
      pending = pending.then(async () => {
        await asyncRepository.updateSessionMetadata(id, patch);
      });
      return current.metadata;
    },
    flush: async () => pending,
  };
}

function mergeMetadata(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = output[key];
    output[key] = isRecord(existing) && isRecord(value)
      ? mergeMetadata(existing, value)
      : value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
