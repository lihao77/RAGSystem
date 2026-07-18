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
    query: {} as MemoryApplication["query"],
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

async function appWith(memory: MemoryApplication) {
  const app = Fastify({ logger: false });
  app.decorateRequest("identity");
  app.addHook("onRequest", async (request) => {
    request.identity = {
      tenantId: createTenantId("tnt_saas"),
      userId: createUserId("usr_admin"),
      role: "admin",
      permissions: [],
    };
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
