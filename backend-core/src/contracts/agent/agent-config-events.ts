export const AGENT_CONFIG_CHANGED_EVENT = "agent.config.changed";

export interface AgentConfigChangedEvent {
  tenantId: string;
  teamName: string;
  change: "updated" | "deleted";
  previousTeamName?: string;
}

export function isAgentConfigChangedEvent(value: unknown): value is AgentConfigChangedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.tenantId === "string"
    && Boolean(event.tenantId.trim())
    && typeof event.teamName === "string"
    && Boolean(event.teamName.trim())
    && (event.change === "updated" || event.change === "deleted")
    && (event.previousTeamName === undefined
      || (typeof event.previousTeamName === "string" && Boolean(event.previousTeamName.trim())));
}
