import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../src/contracts/agent/agent-config.js";
import { computeSessionTeamRevision, type SessionInfo, type SessionTeamSnapshot } from "../src/contracts/session/session.js";
import { TenantSessionIdentityApplication, type SessionIdentityStoragePort } from "../src/services/sessions/session-identity-application.js";

function snapshot(teamName: string): SessionTeamSnapshot {
  const agents = { orchestrator_agent: AgentConfigSchema.parse({ agent_name: "orchestrator_agent" }) };
  return {
    team_name: teamName,
    team_revision: computeSessionTeamRevision(agents),
    entry_agent_name: "orchestrator_agent",
    agents,
  };
}

function legacyRow(sessionId = "legacy-session"): SessionInfo {
  // 历史形状：2026-08 team 快照特性之前落库的会话行，team_snapshot 为 NULL。
  return {
    session_id: sessionId,
    team_snapshot: null,
    tenant_id: "tnt_test" as never,
    owner_user_id: "usr_bot",
    visibility: "private",
    origin_type: "bot",
    origin_id: "usr_bot_1",
    origin_channel: "feishu",
    workspace_id: null,
    permission_mode: null,
    metadata: {},
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
  };
}

function identity(sessionId: string, teamSnapshot: SessionTeamSnapshot) {
  return {
    sessionId,
    ownerUserId: "usr_bot",
    visibility: "private" as const,
    originType: "bot" as const,
    originId: "usr_bot_1",
    originChannel: "feishu" as const,
    workspaceId: null,
    teamSnapshot,
    metadata: {},
  };
}

class MemoryStorage implements SessionIdentityStoragePort {
  rows = new Map<string, SessionInfo>();
  anchorCalls: Array<{ sessionId: string; teamName: string }> = [];

  async getSession(sessionId: string) {
    return this.rows.get(sessionId) ?? null;
  }
  async createSession() {}
  async updateSessionMetadata() {
    return {};
  }
  async anchorSessionTeamSnapshot(sessionId: string, teamSnapshot: SessionTeamSnapshot) {
    const row = this.rows.get(sessionId);
    if (!row || row.team_snapshot !== null) return false;
    this.rows.set(sessionId, { ...row, team_snapshot: teamSnapshot });
    this.anchorCalls.push({ sessionId, teamName: teamSnapshot.team_name });
    return true;
  }
}

describe("legacy NULL team_snapshot anchoring (ensureSession gate)", () => {
  it("anchors an un-anchored legacy row instead of crashing on the snapshot comparison", async () => {
    const storage = new MemoryStorage();
    storage.rows.set("legacy-session", legacyRow());
    const app = new TenantSessionIdentityApplication("tnt_test" as never, storage);

    await app.ensureSession(identity("legacy-session", snapshot("default")));

    expect(storage.anchorCalls).toEqual([{ sessionId: "legacy-session", teamName: "default" }]);
    expect(storage.rows.get("legacy-session")?.team_snapshot?.team_name).toBe("default");
  });

  it("restores strict immutable comparison after anchoring (mismatch still rejected)", async () => {
    const storage = new MemoryStorage();
    storage.rows.set("legacy-session", legacyRow());
    const app = new TenantSessionIdentityApplication("tnt_test" as never, storage);

    await app.ensureSession(identity("legacy-session", snapshot("default")));
    await expect(app.ensureSession(identity("legacy-session", snapshot("default")))).resolves.toBeUndefined();
    await expect(app.ensureSession(identity("legacy-session", snapshot("other-team"))))
      .rejects.toThrow(/immutable identity mismatch/);
    // 二次触达不再重复回填。
    expect(storage.anchorCalls).toHaveLength(1);
  });

  it("still rejects non-snapshot identity drift on legacy rows", async () => {
    const storage = new MemoryStorage();
    storage.rows.set("legacy-session", legacyRow());
    const app = new TenantSessionIdentityApplication("tnt_test" as never, storage);

    const drifted = identity("legacy-session", snapshot("default"));
    await expect(app.ensureSession({ ...drifted, ownerUserId: "usr_other" }))
      .rejects.toThrow(/immutable identity mismatch/);
    expect(storage.anchorCalls).toHaveLength(0);
  });
});
