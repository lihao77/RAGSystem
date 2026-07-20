import { describe, expect, it, vi } from "vitest";

import type { PostgresConversationRepository } from "../../src/adapters/saas/postgres/conversation-repository.js";
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

});

function createState(
  conversations: Record<string, ReturnType<typeof vi.fn>>,
): SaaSDaemonState {
  return new SaaSDaemonState(
    conversations as unknown as Pick<PostgresConversationRepository, "createSession" | "getSession" | "updateSessionMetadata">,
  );
}
