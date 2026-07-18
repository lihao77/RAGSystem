import { describe, expect, it } from "vitest";

import { createJwtKeyRing } from "../../../src/services/runtime/jwt-key-ring.js";

const activeSecret = "active-key-secret-0123456789abcdef0123456789";
const previousSecret = "previous-key-secret-0123456789abcdef012345";

describe("JwtKeyRing", () => {
  it("selects only active for signing and keeps previous keys for verification", () => {
    const ring = createJwtKeyRing({
      active: { kid: "key-v2", secret: activeSecret },
      previous: [{ kid: "key-v1", secret: previousSecret }],
    });
    expect(ring.getActiveSigningKey(100).kid).toBe("key-v2");
    expect(ring.getVerificationKey("key-v1", 100)?.kid).toBe("key-v1");
    expect(ring.getVerificationKey("key-v2", 100)?.kid).toBe("key-v2");
    expect(ring.getVerificationKey("unknown", 100)).toBeNull();
    expect(ring.readiness(100)).toEqual({
      ready: true,
      activeKid: "key-v2",
      verificationKids: ["key-v1", "key-v2"],
    });
  });

  it("rejects expired previous and active keys", () => {
    const ring = createJwtKeyRing({
      active: { kid: "key-v2", secret: activeSecret, expiresAt: 200 },
      previous: [{ kid: "key-v1", secret: previousSecret, expiresAt: 100 }],
    });
    expect(ring.getVerificationKey("key-v1", 100)).toBeNull();
    expect(ring.getVerificationKey("key-v2", 199)?.kid).toBe("key-v2");
    expect(() => ring.getActiveSigningKey(200)).toThrow("active key 已过期");
    expect(ring.readiness(200)).toEqual({
      ready: false,
      activeKid: "key-v2",
      verificationKids: [],
      reason: "active_key_expired",
    });
  });

  it("reports a missing active key as not ready", () => {
    const ring = createJwtKeyRing({ previous: [{ kid: "key-v1", secret: previousSecret }] });
    expect(ring.readiness(100)).toEqual({
      ready: false,
      activeKid: null,
      verificationKids: ["key-v1"],
      reason: "missing_active_key",
    });
    expect(() => ring.getActiveSigningKey(100)).toThrow("缺少 active key");
  });

  it("rejects duplicate kid and weak key material", () => {
    expect(() => createJwtKeyRing({
      active: { kid: "duplicate", secret: activeSecret },
      previous: [{ kid: "duplicate", secret: previousSecret }],
    })).toThrow("kid 重复");
    expect(() => createJwtKeyRing({ active: { kid: "weak", secret: "too-short" } })).toThrow("至少需 32 bytes");
  });
});
