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
        userId: "usr_bot",
        metadata: { chatId: "oc_initial" },
        permissionMode: "standard",
      });
      await harness.application.ensureSession({
        sessionId: "daemon-session",
        userId: "usr_bot",
        metadata: { channel: "feishu" },
        permissionMode: "relaxed",
      });
      await harness.application.updateSessionMetadata("daemon-session", { chatId: "oc_latest" });

      expect(await harness.readRaw("daemon-session")).toMatchObject({
        tenant_id: tenantId,
        user_id: "usr_bot",
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
        userId: "usr_bot",
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
    seedForeign: (sessionId) => conversations.createSession(otherTenantId, sessionId, "usr_other"),
    close: () => conversations.close(),
  };
}

function createSaaSHarness(): Harness {
  const rows = new Map<string, SessionInfo>();
  const repository = {
    getSession: async (sessionId: string) => rows.get(sessionId) ?? null,
    createSession: async (boundTenantId: typeof tenantId, sessionId: string, userId: string, metadata: Record<string, unknown>, permissionMode: SessionInfo["permission_mode"]) => {
      rows.set(sessionId, session(sessionId, boundTenantId, userId, metadata, permissionMode));
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
      rows.set(sessionId, session(sessionId, otherTenantId, "usr_other", {}, null));
    },
    close: () => undefined,
  };
}

function session(
  sessionId: string,
  boundTenantId: SessionInfo["tenant_id"],
  userId: string,
  metadata: Record<string, unknown>,
  permissionMode: SessionInfo["permission_mode"],
): SessionInfo {
  return {
    session_id: sessionId,
    tenant_id: boundTenantId,
    user_id: userId,
    permission_mode: permissionMode,
    metadata,
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  };
}
