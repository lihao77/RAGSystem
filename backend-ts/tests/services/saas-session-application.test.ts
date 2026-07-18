import { describe, expect, it, vi } from "vitest";

import { SaaSSessionApplication } from "../../src/services/runtime/saas-session-application.js";

describe("SaaSSessionApplication", () => {
  it("binds creates and lists to its tenant", async () => {
    const repository = {
      createSession: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0, has_more: false }),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    await application.createSession({ sessionId: "session-1", userId: "user-1", metadata: { team: "default" } });
    await application.listSessions({ limit: 10, offset: 0, userIds: ["user-1"] });

    expect(repository.createSession).toHaveBeenCalledWith("tenant-a", "session-1", "user-1", { team: "default" }, null);
    expect(repository.listSessions).toHaveBeenCalledWith("tenant-a", 10, 0, ["user-1"]);
  });

  it("does not expose or mutate a session owned by another tenant", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({ session_id: "session-1", tenant_id: "tenant-b" }),
      deleteSession: vi.fn(),
      listMessages: vi.fn(),
      updateMessage: vi.fn(),
    };
    const application = new SaaSSessionApplication("tenant-a", repository as never);

    await expect(application.getSession("session-1")).resolves.toBeNull();
    await expect(application.deleteSession("session-1")).resolves.toBe(false);
    await expect(application.listMessages({ sessionId: "session-1" })).resolves.toBeNull();
    await expect(application.updateUserMessage({ sessionId: "session-1", messageId: "message-1", content: "changed" })).resolves.toBe(false);
    expect(repository.deleteSession).not.toHaveBeenCalled();
    expect(repository.listMessages).not.toHaveBeenCalled();
    expect(repository.updateMessage).not.toHaveBeenCalled();
  });
});
