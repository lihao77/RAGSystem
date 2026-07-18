import type { JwtKeyRing, JwtKeyRingReadiness, JwtSigningKey } from "../../contracts/jwt-key-ring.js";

export interface JwtKeyInput {
  kid: string;
  secret: string | Uint8Array;
  expiresAt?: number;
}

export interface InMemoryJwtKeyRingOptions {
  active?: JwtKeyInput;
  previous?: readonly JwtKeyInput[];
}

/** Immutable process-local view of a shared JWT key-ring configuration. */
export class InMemoryJwtKeyRing implements JwtKeyRing {
  private readonly active: JwtSigningKey | null;
  private readonly byKid: ReadonlyMap<string, JwtSigningKey>;

  constructor(options: InMemoryJwtKeyRingOptions) {
    this.active = options.active ? normalizeKey(options.active) : null;
    const keys = [this.active, ...(options.previous ?? []).map(normalizeKey)].filter((key) => key !== null);
    const byKid = new Map<string, JwtSigningKey>();
    for (const key of keys) {
      if (byKid.has(key.kid)) throw new Error(`JWT key kid 重复: ${key.kid}`);
      byKid.set(key.kid, key);
    }
    this.byKid = byKid;
  }

  getActiveSigningKey(nowSeconds = now()): JwtSigningKey {
    if (!this.active) throw new Error("JWT key ring 缺少 active key");
    if (isExpired(this.active, nowSeconds)) throw new Error(`JWT active key 已过期: ${this.active.kid}`);
    return this.active;
  }

  getVerificationKey(kid: string | undefined, nowSeconds = now()): JwtSigningKey | null {
    const key = kid === undefined ? this.active : this.byKid.get(kid) ?? null;
    return key && !isExpired(key, nowSeconds) ? key : null;
  }

  readiness(nowSeconds = now()): JwtKeyRingReadiness {
    if (!this.active) {
      return { ready: false, activeKid: null, verificationKids: activeKids(this.byKid, nowSeconds), reason: "missing_active_key" };
    }
    if (isExpired(this.active, nowSeconds)) {
      return { ready: false, activeKid: this.active.kid, verificationKids: activeKids(this.byKid, nowSeconds), reason: "active_key_expired" };
    }
    return { ready: true, activeKid: this.active.kid, verificationKids: activeKids(this.byKid, nowSeconds) };
  }
}

export function createJwtKeyRing(options: InMemoryJwtKeyRingOptions): JwtKeyRing {
  return new InMemoryJwtKeyRing(options);
}

export function createLegacyJwtKeyRing(secret: string, kid = "legacy"): JwtKeyRing {
  if (!secret || secret.length < 32) throw new Error("JWT secret 至少需 32 字符");
  return createJwtKeyRing({ active: { kid, secret } });
}

function normalizeKey(input: JwtKeyInput): JwtSigningKey {
  const kid = input.kid.trim();
  if (!kid || !/^[A-Za-z0-9._-]+$/.test(kid)) throw new Error("JWT key kid 格式无效");
  const secret = typeof input.secret === "string" ? Buffer.from(input.secret, "utf8") : Uint8Array.from(input.secret);
  if (secret.byteLength < 32) throw new Error(`JWT key secret 至少需 32 bytes: ${kid}`);
  if (input.expiresAt !== undefined && (!Number.isInteger(input.expiresAt) || input.expiresAt < 0)) {
    throw new Error(`JWT key expiresAt 无效: ${kid}`);
  }
  return { kid, secret, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) };
}

function activeKids(keys: ReadonlyMap<string, JwtSigningKey>, nowSeconds: number): string[] {
  return [...keys.values()].filter((key) => !isExpired(key, nowSeconds)).map((key) => key.kid).sort();
}

function isExpired(key: JwtSigningKey, nowSeconds: number): boolean {
  return key.expiresAt !== undefined && key.expiresAt <= nowSeconds;
}

function now(): number { return Math.floor(Date.now() / 1000); }
