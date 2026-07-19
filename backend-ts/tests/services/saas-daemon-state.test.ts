import { describe, expect, it, vi } from "vitest";

import type { PostgresConversationRepository } from "../../src/adapters/saas/postgres/conversation-repository.js";
import type { PostgresPendingInteractionRepository } from "../../src/adapters/saas/postgres/pending-interaction-repository.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";
import { SaaSDaemonState } from "../../src/adapters/saas/composition/saas-daemon-state.js";

const tenantId = createTenantId("tnt_a");
const botId = createUserId("usr_bot_a");

describe("SaaSDaemonState", () => {
  it("creates the daemon session in PostgreSQL with bot ownership and metadata", async () => {
    const conversations = {
      getSession: vi.fn().mockResolvedValue(null),
      createSession: vi.fn().mockResolvedValue(undefined),
      updateSessionMetadata: vi.fn(),
    };
    const state = createState(conversations);

    await state.ensureSession({
      tenantId,
      sessionId: "daemon-session",
      botId,
      metadata: { chatId: "oc_chat" },
      permissionMode: "relaxed",
    });

    expect(conversations.createSession).toHaveBeenCalledWith(
      tenantId,
      "daemon-session",
      botId,
      { chatId: "oc_chat" },
      "relaxed",
    );
  });

  it("rejects a globally colliding session owned by another tenant", async () => {
    const conversations = {
      getSession: vi.fn().mockResolvedValue({ tenant_id: createTenantId("tnt_b") }),
      createSession: vi.fn(),
      updateSessionMetadata: vi.fn(),
    };
    const state = createState(conversations);

    await expect(state.ensureSession({
      tenantId,
      sessionId: "shared-id",
      botId,
      permissionMode: "standard",
    })).rejects.toThrow("belongs to another tenant");
    expect(conversations.createSession).not.toHaveBeenCalled();
  });

  it("loads only unresolved interactions and restores card fields from durable payload", async () => {
    const conversations = {
      getSession: vi.fn().mockResolvedValue({ tenant_id: tenantId }),
      createSession: vi.fn(),
      updateSessionMetadata: vi.fn(),
    };
    const pending = {
      listPendingInteractions: vi.fn().mockResolvedValue([{
        interaction_id: "approval-1",
        session_id: "daemon-session",
        run_id: "run-1",
        root_run_id: "root-1",
        tool_call_id: "call-1",
        batch_id: "batch-1",
        kind: "approval",
        status: "suspended",
        request_payload: {
          toolName: "execute_bash",
          riskLevel: "high",
          reason: "approval required",
          options: ["yes", 42],
        },
        resolution_payload: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        responded_at: null,
        consumed_at: null,
      }]),
    };
    const state = createState(conversations, pending);

    await expect(state.listSuspendedInteractions({
      tenantId,
      sessionId: "daemon-session",
      rootRunId: "root-1",
      botId,
    })).resolves.toEqual([expect.objectContaining({
      approvalId: "approval-1",
      botId,
      kind: "approval",
      toolName: "execute_bash",
      riskLevel: "high",
      reason: "approval required",
      options: ["yes"],
    })]);
    expect(pending.listPendingInteractions).toHaveBeenCalledWith({
      sessionId: "daemon-session",
      rootRunId: "root-1",
      statuses: ["waiting", "suspended"],
    });
  });
});

function createState(
  conversations: Record<string, ReturnType<typeof vi.fn>>,
  pending: Record<string, ReturnType<typeof vi.fn>> = { listPendingInteractions: vi.fn().mockResolvedValue([]) },
): SaaSDaemonState {
  return new SaaSDaemonState(
    conversations as unknown as Pick<PostgresConversationRepository, "createSession" | "getSession" | "updateSessionMetadata">,
    pending as unknown as Pick<PostgresPendingInteractionRepository, "listPendingInteractions">,
  );
}
