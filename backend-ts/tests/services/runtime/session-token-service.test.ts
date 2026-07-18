import { describe, expect, it, vi } from "vitest";

import { createTenantId, createUserId } from "../../../src/identity/types.js";
import { AuthError } from "../../../src/services/identity/index.js";
import { createSessionTokenService } from "../../../src/services/runtime/session-token-service.js";

describe("SessionTokenService", () => {
  it("签发 session scope token 并支持撤销", async () => {
    const revoked = new Set<string>();
    const service = createSessionTokenService("session-secret-0123456789abcdef0123456789", {
      isSessionRevoked: async (_tenantId, jti) => revoked.has(jti),
      revokeSession: async (jti) => { revoked.add(jti); return true; },
    });
    const issued = service.issueToken({ userId: createUserId("usr_alice"), tenantId: createTenantId("tnt_acme"), role: "owner" });
    await expect(service.verifyToken(issued.token)).resolves.toEqual(expect.objectContaining({ scope: "session", role: "owner" }));
    await expect(service.revoke(issued.claims.jti)).resolves.toBe(true);
    await expect(service.verifyToken(issued.token)).rejects.toThrow(AuthError);
  });

  it("拒绝过期 token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const service = createSessionTokenService("session-secret-0123456789abcdef0123456789", {
      isSessionRevoked: () => false,
      revokeSession: () => true,
    }, 1);
    const issued = service.issueToken({ userId: createUserId("usr_alice"), tenantId: createTenantId("tnt_acme"), role: "owner" });
    vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
    await expect(service.verifyToken(issued.token)).rejects.toThrow("token expired");
    vi.useRealTimers();
  });

  it("waits for asynchronous revocation reads and writes", async () => {
    let releaseRead!: (value: boolean) => void;
    let releaseWrite!: (value: boolean) => void;
    const read = new Promise<boolean>((resolve) => { releaseRead = resolve; });
    const write = new Promise<boolean>((resolve) => { releaseWrite = resolve; });
    const service = createSessionTokenService("session-secret-0123456789abcdef0123456789", {
      isSessionRevoked: () => read,
      revokeSession: () => write,
    });
    const issued = service.issueToken({ userId: createUserId("usr_async"), tenantId: createTenantId("tnt_async"), role: "member" });
    let verified = false;
    const verification = service.verifyToken(issued.token).then((claims) => { verified = true; return claims; });
    await Promise.resolve();
    expect(verified).toBe(false);
    releaseRead(false);
    await expect(verification).resolves.toMatchObject({ sub: "usr_async" });

    let revoked = false;
    const revocation = service.revoke(issued.claims.jti).then((result) => { revoked = true; return result; });
    await Promise.resolve();
    expect(revoked).toBe(false);
    releaseWrite(true);
    await expect(revocation).resolves.toBe(true);
  });
});
