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
  it("issues a session-bound ticket that can only be consumed once", () => {
    const service = createWsTicketService();
    const issued = service.issue(identity, "session-1");

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(service.consume(issued.ticket, "session-1")).toEqual(identity);
    expect(() => service.consume(issued.ticket, "session-1")).toThrow("invalid or expired");
  });

  it("invalidates a ticket when it is used for the wrong session", () => {
    const service = createWsTicketService();
    const issued = service.issue(identity, "session-1");

    expect(() => service.consume(issued.ticket, "session-2")).toThrow("session mismatch");
    expect(() => service.consume(issued.ticket, "session-1")).toThrow("invalid or expired");
  });

  it("rejects expired tickets", () => {
    let currentTime = 1_000;
    const service = createWsTicketService({ ttlMs: 100, now: () => currentTime });
    const issued = service.issue(identity, "session-1");
    currentTime += 101;
    expect(() => service.consume(issued.ticket, "session-1")).toThrow("invalid or expired");
  });
});
