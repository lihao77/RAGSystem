import { describe, expect, it } from "vitest";

import { createTenantId, createUserId, type RequestIdentity } from "../../src/identity/types.js";
import { createWsTicketService } from "../../src/services/runtime/ws-ticket-service.js";

const identity: RequestIdentity = {
  userId: createUserId("usr_ticket_test"),
  tenantId: createTenantId("tnt_ticket_test"),
  role: "owner",
  permissions: ["*"],
};

describe("WsTicketService", () => {
  it("issues a session-bound ticket that can only be consumed once", async () => {
    const service = createWsTicketService();
    const issued = await service.issue(identity, "session-1");

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(Promise.resolve(service.consume(issued.ticket, "session-1"))).resolves.toEqual(identity);
    await expect(Promise.resolve().then(() => service.consume(issued.ticket, "session-1")))
      .rejects.toThrow("invalid or expired");
  });

  it("invalidates a ticket when it is used for the wrong session", async () => {
    const service = createWsTicketService();
    const issued = await service.issue(identity, "session-1");

    await expect(Promise.resolve().then(() => service.consume(issued.ticket, "session-2")))
      .rejects.toThrow("session mismatch");
    await expect(Promise.resolve().then(() => service.consume(issued.ticket, "session-1")))
      .rejects.toThrow("invalid or expired");
  });

  it("rejects expired tickets", async () => {
    let currentTime = 1_000;
    const service = createWsTicketService({ ttlMs: 100, now: () => currentTime });
    const issued = await service.issue(identity, "session-1");
    currentTime += 101;
    await expect(Promise.resolve().then(() => service.consume(issued.ticket, "session-1")))
      .rejects.toThrow("invalid or expired");
  });
});
