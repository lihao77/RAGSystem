import type { MemoryScopeSpec } from "../../contracts/memory-store/index.js";
import type { MemoryScopePartition } from "./types.js";

/** Convert a deployment-neutral scope spec into the stable database partition key. */
export function toMemoryScopePartition(scopeSpec: MemoryScopeSpec): MemoryScopePartition | null {
  switch (scopeSpec.scope) {
    case "team":
      return singleKeyPartition("team", scopeSpec.team_name);
    case "session":
      return singleKeyPartition("session", scopeSpec.session_id);
    case "user":
      return singleKeyPartition("user", scopeSpec.user_id);
    case "agent": {
      const teamName = normalize(scopeSpec.team_name);
      const agentName = normalize(scopeSpec.agent_name);
      return teamName && agentName
        ? { scope: "agent", scope_id: JSON.stringify([teamName, agentName]) }
        : null;
    }
    case "workspace": {
      const userId = normalize(scopeSpec.user_id);
      const workspaceKey = normalize(scopeSpec.workspace_key);
      return userId && workspaceKey
        ? { scope: "workspace", scope_id: JSON.stringify([userId, workspaceKey]) }
        : null;
    }
  }
}

function singleKeyPartition(
  scope: "team" | "session" | "user",
  value: string | undefined,
): MemoryScopePartition | null {
  const scopeId = normalize(value);
  return scopeId ? { scope, scope_id: scopeId } : null;
}

function normalize(value: string | undefined): string {
  return value?.trim() ?? "";
}
