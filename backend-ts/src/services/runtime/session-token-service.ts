import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { createTenantId, createUserId, type TenantId, type UserId } from "../../identity/types.js";
import { AuthError } from "../identity/auth-error.js";

export interface SessionTokenClaims {
  sub: UserId;
  tenant_id: TenantId;
  role: string;
  jti: string;
  iat: number;
  exp: number;
  scope: "session";
  platform_role?: "admin";
}

export interface SessionOps {
  isSessionRevoked(tenantId: TenantId, jti: string): Promise<boolean>;
  revokeSession(jti: string): Promise<boolean>;
}

export interface SessionTokenService {
  issueToken(user: { userId: UserId; tenantId: TenantId; role: string; platformRole?: "admin" }): { token: string; expires_at: number; claims: SessionTokenClaims };
  verifyToken(token: string): Promise<SessionTokenClaims>;
  requireBearer(request: FastifyRequest): Promise<SessionTokenClaims>;
  revoke(jti: string): Promise<boolean>;
}

export function createSessionTokenService(secret: string, sessionOps: SessionOps, ttlHours = 168): SessionTokenService {
  if (!secret || secret.length < 32) throw new Error("SESSION_JWT_SECRET 至少需 32 字符");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("SESSION_TOKEN_TTL_HOURS 必须为正数");
  const key = Buffer.from(secret, "utf8");
  const ttlSeconds = Math.floor(ttlHours * 60 * 60);

  const sign = (claims: SessionTokenClaims): string => {
    const headerSegment = base64urlJson({ alg: "HS256", typ: "JWT" });
    const payloadSegment = base64urlJson(claims);
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = createHmac("sha256", key).update(signingInput).digest().toString("base64url");
    return `${signingInput}.${signature}`;
  };

  const verifyToken = async (token: string): Promise<SessionTokenClaims> => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new AuthError("malformed token");
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    if (!headerSegment || !payloadSegment || !signatureSegment) throw new AuthError("malformed token");
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const expected = createHmac("sha256", key).update(signingInput).digest();
    const actual = Buffer.from(signatureSegment, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new AuthError("invalid signature");
    let claims: Partial<SessionTokenClaims>;
    try {
      claims = parseBase64urlJson(payloadSegment) as Partial<SessionTokenClaims>;
    } catch {
      throw new AuthError("invalid claims");
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp < now) throw new AuthError("token expired");
    if (claims.scope !== "session") throw new AuthError("invalid scope");
    if (typeof claims.sub !== "string" || typeof claims.tenant_id !== "string" || typeof claims.role !== "string" || typeof claims.jti !== "string" || typeof claims.iat !== "number") {
      throw new AuthError("invalid claims");
    }
    const normalized = {
      ...claims,
      sub: createUserId(claims.sub),
      tenant_id: createTenantId(claims.tenant_id),
    } as SessionTokenClaims;
    if (await sessionOps.isSessionRevoked(normalized.tenant_id, normalized.jti)) throw new AuthError("token revoked");
    return normalized;
  };

  return {
    issueToken(user) {
      const now = Math.floor(Date.now() / 1000);
      const claims: SessionTokenClaims = {
        sub: user.userId,
        tenant_id: user.tenantId,
        role: user.role,
        jti: randomUUID(),
        iat: now,
        exp: now + ttlSeconds,
        scope: "session",
        ...(user.platformRole ? { platform_role: user.platformRole } : {}),
      };
      return { token: sign(claims), expires_at: claims.exp, claims };
    },
    verifyToken,
    async requireBearer(request) {
      const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
      if (!match?.[1]) throw new AuthError("missing bearer token");
      return await verifyToken(match[1]);
    },
    async revoke(jti) {
      return await sessionOps.revokeSession(jti);
    },
  };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}
