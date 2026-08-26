import { describe, expect, it } from "vitest";

import {
  AGENT_DELETED_EVENT,
  SESSION_DELETED_EVENT,
  TEAM_DELETED_EVENT,
  TEAM_RENAMED_EVENT,
  isAgentDeletedEvent,
  isSessionDeletedEvent,
  isTeamDeletedEvent,
  isTeamRenamedEvent,
} from "../src/contracts/runtime/entity-lifecycle-events.js";

describe("entity lifecycle event contract", () => {
  it("exposes stable event names", () => {
    expect(SESSION_DELETED_EVENT).toBe("session.deleted");
    expect(AGENT_DELETED_EVENT).toBe("agent.deleted");
    expect(TEAM_DELETED_EVENT).toBe("team.deleted");
    expect(TEAM_RENAMED_EVENT).toBe("team.renamed");
  });

  it("recognizes session.deleted payloads", () => {
    expect(isSessionDeletedEvent({ tenantId: "tnt_a", sessionId: "ses_1" })).toBe(true);
    expect(isSessionDeletedEvent({ tenantId: "tnt_a", sessionId: "" })).toBe(false);
    expect(isSessionDeletedEvent({ tenantId: "", sessionId: "ses_1" })).toBe(false);
    expect(isSessionDeletedEvent({ sessionId: "ses_1" })).toBe(false);
    expect(isSessionDeletedEvent(null)).toBe(false);
  });

  it("recognizes agent.deleted payloads", () => {
    expect(isAgentDeletedEvent({ tenantId: "tnt_a", teamName: "default", agentName: "writer" })).toBe(true);
    expect(isAgentDeletedEvent({ tenantId: "tnt_a", teamName: "default" })).toBe(false);
    expect(isAgentDeletedEvent({ tenantId: "tnt_a", teamName: " ", agentName: "writer" })).toBe(false);
  });

  it("recognizes team.deleted payloads", () => {
    expect(isTeamDeletedEvent({ tenantId: "tnt_a", teamName: "default" })).toBe(true);
    expect(isTeamDeletedEvent({ tenantId: "tnt_a", teamName: "" })).toBe(false);
    expect(isTeamDeletedEvent({ teamName: "default" })).toBe(false);
  });

  it("recognizes team.renamed payloads", () => {
    expect(isTeamRenamedEvent({ tenantId: "tnt_a", previousTeamName: "old", teamName: "new" })).toBe(true);
    expect(isTeamRenamedEvent({ tenantId: "tnt_a", previousTeamName: "", teamName: "new" })).toBe(false);
    expect(isTeamRenamedEvent({ tenantId: "tnt_a", teamName: "new" })).toBe(false);
  });
});
