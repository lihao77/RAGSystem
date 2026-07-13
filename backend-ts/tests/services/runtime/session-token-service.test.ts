import { describe, expect, it, vi } from "vitest";

import { createTenantId, createUserId } from "../../../src/identity/types.js";
import { AuthError } from "../../../src/services/identity/index.js";
import { createSessionTokenService } from "../../../src/services/runtime/session-token-service.js";

describe("SessionTokenService", () => {
  it("签发 session scope token 并支持撤销", () => {
    const revoked = new Set<string>();
    const service = createSessionTokenService("session-secret-0123456789abcdef0123456789", {
      isSessionRevoked: (_tenantId, jti) => revoked.has(jti),
      revokeSession: (jti) => { revoked.add(jti); return true; },
    });
    const issued = service.issueToken({ userId: createUserId("usr_alice"), tenantId: createTenantId("tnt_acme"), role: "owner" });
    expect(service.verifyToken(issued.token)).toEqual(expect.objectContaining({ scope: "session", role: "owner" }));
    service.revoke(issued.claims.jti);
    expect(() => service.verifyToken(issued.token)).toThrow(AuthError);
  });

  it("拒绝过期 token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const service = createSessionTokenService("session-secret-0123456789abcdef0123456789", {
      isSessionRevoked: () => false,
      revokeSession: () => true,
    }, 1);
    const issued = service.issueToken({ userId: createUserId("usr_alice"), tenantId: createTenantId("tnt_acme"), role: "owner" });
    vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
    expect(() => service.verifyToken(issued.token)).toThrow("token expired");
    vi.useRealTimers();
  });
});
