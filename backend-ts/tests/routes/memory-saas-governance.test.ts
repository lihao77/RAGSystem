import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  PersistedMemoryCandidate,
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateMutationResult,
  PersistedMemoryEntry,
} from "../../src/contracts/memory-store/index.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";
import { registerMemoryRoutes } from "../../src/routes/memory.js";
import type { RouteOptions } from "../../src/routes/route-options.js";
import type { MemoryApplication } from "../../src/services/memory/index.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-18T00:00:00.000Z";

function candidate(version = 1): PersistedMemoryCandidate {
  return {
    id: candidateId,
    tenant_id: "tnt_saas",
    scope: "team",
    scope_id: "team-1",
    owner_user_id: "usr_owner",
    operation: "publish",
    target_memory_id: null,
    name: "Policy",
    description: "Shared policy",
    memory_type: "fact",
    content: "Use citations.",
    why: null,
    how_to_apply: null,
    status: "candidate",
    source_session_id: null,
    source_run_id: null,
    source_message_id: null,
    reviewer_user_id: null,
    review_comment: null,
    published_memory_id: null,
    version,
    created_at: now,
    updated_at: now,
    reviewed_at: null,
  };
}

function memoryEntry(): PersistedMemoryEntry {
  return {
    id: "memory-1",
    tenant_id: "tnt_saas",
    scope: "team",
    scope_id: "team-1",
    name: "Policy",
    description: "Shared policy",
    memory_type: "fact",
    content: "Use citations.",
    why: null,
    how_to_apply: null,
    status: "active",
    source_run_id: null,
    source_message_id: null,
    version: 1,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

function application(): MemoryApplication {
  return {
    query: {
      getEntry: vi.fn(),
      listEntries: vi.fn(),
      getScopeRevision: vi.fn(),
      listManagedEntries: vi.fn(async () => [memoryEntry()]),
      countManagedEntries: vi.fn(async () => 3),
    },
    commands: {
      createCandidate: vi.fn(),
      updateCandidate: vi.fn(async (): Promise<PersistedMemoryCandidateMutationResult> => ({ outcome: "applied", candidate: candidate(2) })),
      withdrawCandidate: vi.fn(async (): Promise<PersistedMemoryCandidateMutationResult> => ({ outcome: "applied", candidate: candidate(2) })),
    },
    governance: {
      getCandidate: vi.fn(async () => candidate()),
      listCandidates: vi.fn(async () => [candidate()]),
      countCandidates: vi.fn(async () => 1),
      claimCandidate: vi.fn(async (): Promise<PersistedMemoryCandidateClaimResult> => ({
        outcome: "claimed",
        candidate: candidate(2),
        review_claim_token: "claim-token",
      })),
      releaseCandidate: vi.fn(),
      rejectCandidate: vi.fn(async (): Promise<PersistedMemoryCandidateMutationResult> => ({ outcome: "applied", candidate: candidate(3) })),
      approveCandidate: vi.fn(async (): Promise<PersistedMemoryCandidateApprovalResult> => ({
        outcome: "published",
        candidate: { ...candidate(3), status: "approved" },
        memory: memoryEntry(),
        scope_revision: 1,
      })),
    },
  };
}

async function appWith(
  memory: MemoryApplication,
  identity: { role?: "owner" | "admin" | "member"; userId?: string } = {},
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("identity");
  app.decorateRequest("container");
  app.addHook("onRequest", async (request) => {
    request.identity = {
      tenantId: createTenantId("tnt_saas"),
      userId: createUserId(identity.userId ?? "usr_admin"),
      role: identity.role ?? "admin",
      permissions: [],
    };
    request.container = {
      sessionApplication: {
        listSessions: vi.fn(() => ({
          items: [{ session_id: "session-owned" }],
          total: 1,
          limit: 10_000,
          offset: 0,
          has_more: false,
        })),
      },
    } as unknown as typeof request.container;
  });
  await app.register(registerMemoryRoutes, {
    prefix: "/api/memory",
    registry: {} as RouteOptions["registry"],
    identityProvider: {} as RouteOptions["identityProvider"],
    resolveMemoryApplication: async () => memory,
  });
  await app.ready();
  return app;
}

describe("SaaS memory governance routes", () => {
  it("applies owner visibility to managed entries even for an administrator", async () => {
    const memory = application();
    const app = await appWith(memory);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/memory/entries?scope=user,team&status=active&search=policy&limit=2&offset=1",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        data: { total: 3, limit: 2, offset: 1, has_more: true },
      });
      expect(memory.query.countManagedEntries).toHaveBeenCalledWith({
        scopes: ["user", "team"],
        statuses: ["active"],
        search: "policy",
        viewer_user_id: "usr_admin",
        viewer_session_ids: ["session-owned"],
      });
      expect(memory.query.listManagedEntries).toHaveBeenCalledWith({
        scopes: ["user", "team"],
        statuses: ["active"],
        search: "policy",
        viewer_user_id: "usr_admin",
        viewer_session_ids: ["session-owned"],
        limit: 2,
        offset: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("limits a member to shared entries and their own personal partitions", async () => {
    const memory = application();
    const app = await appWith(memory, { role: "member", userId: "usr_member" });
    try {
      const response = await app.inject({ method: "GET", url: "/api/memory/entries?status=archived" });
      expect(response.statusCode).toBe(200);
      const visibility = {
        statuses: ["archived"],
        viewer_user_id: "usr_member",
        viewer_session_ids: ["session-owned"],
      };
      expect(memory.query.countManagedEntries).toHaveBeenCalledWith(visibility);
      expect(memory.query.listManagedEntries).toHaveBeenCalledWith({
        ...visibility,
        limit: 50,
        offset: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown managed-entry scope before querying storage", async () => {
    const memory = application();
    const app = await appWith(memory);
    try {
      const response = await app.inject({ method: "GET", url: "/api/memory/entries?scope=tenant" });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(memory.query.listManagedEntries).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("archives an owned personal entry immediately", async () => {
    const memory = application();
    const entry = { ...memoryEntry(), id: entryId, scope: "user" as const, scope_id: "usr_member" };
    const archiveCandidate = {
      ...candidate(),
      scope: "user" as const,
      scope_id: "usr_member",
      operation: "archive" as const,
      target_memory_id: entry.id,
      owner_user_id: "usr_member",
    };
    vi.mocked(memory.query.getEntry).mockResolvedValue(entry);
    vi.mocked(memory.commands.createCandidate).mockResolvedValue(archiveCandidate);
    vi.mocked(memory.governance.approveCandidate).mockResolvedValue({
      outcome: "archived",
      candidate: { ...archiveCandidate, status: "approved" },
      memory: { ...entry, status: "archived", archived_at: now },
      scope_revision: 2,
    });
    const app = await appWith(memory, { role: "member", userId: "usr_member" });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/memory/entries/${entryId}/archive`,
        payload: { expected_version: entry.version },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ success: true, data: { status: "archived" } });
      expect(memory.commands.createCandidate).toHaveBeenCalledWith(expect.objectContaining({
        operation: "archive",
        owner_user_id: "usr_member",
        target_memory_id: entryId,
        scope: "user",
        scope_id: "usr_member",
      }));
      expect(memory.governance.approveCandidate).toHaveBeenCalledWith(expect.objectContaining({
        candidate_id: archiveCandidate.id,
        reviewer_user_id: "usr_member",
        expected_version: archiveCandidate.version,
      }));
    } finally {
      await app.close();
    }
  });

  it("does not let a member create an archive candidate for shared memory", async () => {
    const memory = application();
    vi.mocked(memory.query.getEntry).mockResolvedValue({ ...memoryEntry(), id: entryId });
    const app = await appWith(memory, { role: "member", userId: "usr_member" });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/memory/entries/${entryId}/archive`,
        payload: { expected_version: 1 },
      });
      expect(response.statusCode).toBe(404);
      expect(memory.commands.createCandidate).not.toHaveBeenCalled();
      expect(memory.governance.approveCandidate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a conflict before creating an archive candidate for a stale entry version", async () => {
    const memory = application();
    vi.mocked(memory.query.getEntry).mockResolvedValue({
      ...memoryEntry(),
      id: entryId,
      scope: "user",
      scope_id: "usr_member",
      version: 3,
    });
    const app = await appWith(memory, { role: "member", userId: "usr_member" });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/memory/entries/${entryId}/archive`,
        payload: { expected_version: 2 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "conflict" });
      expect(memory.commands.createCandidate).not.toHaveBeenCalled();
      expect(memory.governance.approveCandidate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("lists, updates, and withdraws through MemoryApplication", async () => {
    const memory = application();
    const app = await appWith(memory);
    try {
      const listed = await app.inject({ method: "GET", url: "/api/memory/candidates?target_scope=team" });
      expect(listed.statusCode).toBe(200);
      expect(memory.governance.listCandidates).toHaveBeenCalledWith(expect.objectContaining({
        owner_user_id: "usr_admin",
        scope: "team",
      }));

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/memory/candidates/${candidateId}`,
        payload: { expected_version: 1, content: "Updated" },
      });
      expect(updated.statusCode).toBe(200);
      expect(memory.commands.updateCandidate).toHaveBeenCalledWith(expect.objectContaining({
        candidate_id: candidateId,
        expected_version: 1,
        owner_user_id: "usr_admin",
      }));

      const withdrawn = await app.inject({
        method: "DELETE",
        url: `/api/memory/candidates/${candidateId}`,
        payload: { expected_version: 2 },
      });
      expect(withdrawn.statusCode).toBe(200);
      expect(memory.commands.withdrawCandidate).toHaveBeenCalledWith(expect.objectContaining({ expected_version: 2 }));
    } finally {
      await app.close();
    }
  });

  it("limits the administrator review queue to governed scopes by default", async () => {
    const memory = application();
    const app = await appWith(memory);
    try {
      const response = await app.inject({ method: "GET", url: "/api/memory/admin/candidates" });
      expect(response.statusCode).toBe(200);
      expect(memory.governance.countCandidates).toHaveBeenCalledWith({
        statuses: ["candidate"],
        scopes: ["team", "agent"],
      });
      expect(memory.governance.listCandidates).toHaveBeenCalledWith({
        statuses: ["candidate"],
        scopes: ["team", "agent"],
        limit: 50,
        offset: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("does not allow administrators to approve or reject personal candidates", async () => {
    const memory = application();
    vi.mocked(memory.governance.getCandidate).mockResolvedValue({
      ...candidate(),
      scope: "user",
      scope_id: "usr_owner",
    });
    const app = await appWith(memory);
    try {
      const approve = await app.inject({
        method: "POST",
        url: `/api/memory/admin/candidates/${candidateId}/approve`,
        payload: { expected_version: 1 },
      });
      const reject = await app.inject({
        method: "POST",
        url: `/api/memory/admin/candidates/${candidateId}/reject`,
        payload: { expected_version: 1 },
      });
      expect(approve.statusCode).toBe(400);
      expect(reject.statusCode).toBe(400);
      expect(memory.governance.claimCandidate).not.toHaveBeenCalled();
      expect(memory.governance.approveCandidate).not.toHaveBeenCalled();
      expect(memory.governance.rejectCandidate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("passes the version and generated claim token into atomic approval", async () => {
    const memory = application();
    const app = await appWith(memory);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/memory/admin/candidates/${candidateId}/approve`,
        payload: { expected_version: 1, comment: "approved" },
      });
      expect(response.statusCode).toBe(200);
      expect(memory.governance.claimCandidate).toHaveBeenCalledWith(expect.objectContaining({
        expected_version: 1,
        reviewer_user_id: "usr_admin",
      }));
      expect(memory.governance.approveCandidate).toHaveBeenCalledWith({
        candidate_id: candidateId,
        reviewer_user_id: "usr_admin",
        expected_version: 2,
        review_claim_token: "claim-token",
        review_comment: "approved",
      });
    } finally {
      await app.close();
    }
  });

  it("returns a conflict for stale SaaS mutations", async () => {
    const memory = application();
    vi.mocked(memory.commands.updateCandidate).mockResolvedValue({ outcome: "state_conflict" });
    const app = await appWith(memory);
    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/memory/candidates/${candidateId}`,
        payload: { expected_version: 7, content: "stale" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "conflict" });
    } finally {
      await app.close();
    }
  });
});
