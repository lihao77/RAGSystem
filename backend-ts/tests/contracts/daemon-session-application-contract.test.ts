import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalSessionApplication } from "../../src/adapters/local/application/session/local-session-application.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LocalAgentSessionRepository } from "../../src/adapters/local/local-agent-session-repository.js";
import { SaaSSessionApplication } from "../../src/adapters/saas/application/session/saas-session-application.js";
import type { SessionApplication } from "../../src/contracts/session/session-application.js";
import type { SessionInfo } from "../../src/contracts/session/session.js";
import { createTenantId } from "../../src/identity/types.js";
import { AgentSessionApplication } from "../../src/services/sessions/index.js";
import { makeTempDb, makeTempRoot } from "../helpers/temp-db.js";

const tenantId = createTenantId("tnt_daemon_a");
const otherTenantId = createTenantId("tnt_daemon_b");

interface Harness {
  application: Pick<SessionApplication, "ensureSession" | "updateSessionMetadata">;
  readRaw(sessionId: string): SessionInfo | null | Promise<SessionInfo | null>;
  seedForeign(sessionId: string): void | Promise<void>;
  close(): void;
}

const factories: Array<{ name: string; create(): Harness }> = [
  { name: "Local", create: createLocalHarness },
  { name: "SaaS", create: createSaaSHarness },
];

describe.each(factories)("$name daemon session application contract", ({ create }) => {
  it("ensures and updates a tenant-owned daemon session", async () => {
    const harness = create();
    try {
      await harness.application.ensureSession({
        sessionId: "daemon-session",
        ownerUserId: "usr_bot",
        visibility: "tenant",
        originType: "bot",
        originId: "bot-feishu",
        originChannel: "feishu",
        workspaceId: null,
        metadata: { chatId: "oc_initial" },
        permissionMode: "standard",
      });
      await harness.application.ensureSession({
        sessionId: "daemon-session",
        ownerUserId: "usr_bot",
        visibility: "tenant",
        originType: "bot",
        originId: "bot-feishu",
        originChannel: "feishu",
        workspaceId: null,
        metadata: { channel: "feishu" },
        permissionMode: "relaxed",
      });
      await harness.application.updateSessionMetadata("daemon-session", { chatId: "oc_latest" });

      expect(await harness.readRaw("daemon-session")).toMatchObject({
        tenant_id: tenantId,
        owner_user_id: "usr_bot",
        visibility: "tenant",
        origin_type: "bot",
        origin_id: "bot-feishu",
        origin_channel: "feishu",
        permission_mode: "standard",
        metadata: { chatId: "oc_latest", channel: "feishu" },
      });
    } finally {
      harness.close();
    }
  });

  it("rejects a globally colliding session owned by another tenant", async () => {
    const harness = create();
    try {
      await harness.seedForeign("shared-session");
      await expect(harness.application.ensureSession({
        sessionId: "shared-session",
        ownerUserId: "usr_bot",
        visibility: "tenant",
        originType: "bot",
        originId: "bot-feishu",
        originChannel: "feishu",
        workspaceId: null,
        permissionMode: "standard",
      })).rejects.toThrow("belongs to another tenant");
      await expect(harness.application.updateSessionMetadata("shared-session", { chatId: "oc_bad" }))
        .rejects.toThrow("not found for tenant");
    } finally {
      harness.close();
    }
  });
});

describe("daemon session composition", () => {
  it("keeps deployment branching out of app runAgentTask", () => {
    const source = fs.readFileSync(path.resolve("src/app.ts"), "utf8");
    expect(source).not.toContain("SaaSDaemonState");
    expect(source).not.toContain("saasDaemonState");
    expect(source).not.toContain("lease.runtime.local");
    expect(source).toContain("lease.runtime.sessionApplication.ensureSession");
    expect(source).toContain("lease.runtime.sessionApplication.updateSessionMetadata");
  });
});

function createLocalHarness(): Harness {
  const conversations = createConversationStore({ dbPath: makeTempDb(), dataRoot: makeTempRoot() });
  const sessions = new AgentSessionApplication(new LocalAgentSessionRepository(conversations));
  return {
    application: new LocalSessionApplication(tenantId, sessions, conversations),
    readRaw: (sessionId) => conversations.getSession(sessionId),
    seedForeign: (sessionId) => conversations.createSession({ tenantId: otherTenantId, sessionId: sessionId, ownerUserId: "usr_other", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null }),
    close: () => conversations.close(),
  };
}

function createSaaSHarness(): Harness {
  const rows = new Map<string, SessionInfo>();
  const repository = {
    getSession: async (sessionId: string) => rows.get(sessionId) ?? null,
    createSession: async (input: {
      tenantId: typeof tenantId;
      sessionId: string;
      ownerUserId: string | null;
      visibility: SessionInfo["visibility"];
      originType: SessionInfo["origin_type"];
      originId: string | null;
      originChannel: SessionInfo["origin_channel"];
      workspaceId: string | null;
      metadata?: Record<string, unknown>;
      permissionMode?: SessionInfo["permission_mode"];
    }) => {
      rows.set(input.sessionId, session(input));
    },
    updateSessionMetadata: async (sessionId: string, patch: Record<string, unknown>) => {
      const current = rows.get(sessionId);
      if (!current) return null;
      const metadata = { ...current.metadata, ...patch };
      rows.set(sessionId, { ...current, metadata });
      return metadata;
    },
  };
  return {
    application: new SaaSSessionApplication(tenantId, repository as never),
    readRaw: (sessionId) => repository.getSession(sessionId),
    seedForeign: (sessionId) => {
      rows.set(sessionId, session({ tenantId: otherTenantId, sessionId, ownerUserId: "usr_other", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null, metadata: {}, permissionMode: null }));
    },
    close: () => undefined,
  };
}

function session(input: {
  sessionId: string;
  tenantId: SessionInfo["tenant_id"];
  ownerUserId: string | null;
  visibility: SessionInfo["visibility"];
  originType: SessionInfo["origin_type"];
  originId: string | null;
  originChannel: SessionInfo["origin_channel"];
  workspaceId: string | null;
  metadata?: Record<string, unknown>;
  permissionMode?: SessionInfo["permission_mode"];
}): SessionInfo {
  return {
    session_id: input.sessionId,
    tenant_id: input.tenantId,
    owner_user_id: input.ownerUserId,
    visibility: input.visibility,
    origin_type: input.originType,
    origin_id: input.originId,
    origin_channel: input.originChannel,
    workspace_id: input.workspaceId,
    permission_mode: input.permissionMode ?? null,
    metadata: input.metadata ?? {},
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  };
}
