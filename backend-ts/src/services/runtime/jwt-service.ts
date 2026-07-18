import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

import type {
  WidgetAppCredential,
  WidgetCredentialRepository,
} from "../../contracts/widget-credentials.js";
import type { JwtKeyRing, JwtSigningKey } from "../../contracts/jwt-key-ring.js";
import { createTenantId, type TenantId } from "../../identity/types.js";
import { AuthError } from "../identity/auth-error.js";

/** widget 短时 token 的 TTL（秒）。 */
const TOKEN_TTL_SECONDS = 15 * 60;

export interface WidgetTokenClaims {
  /** app_key（主体）。 */
  sub: string;
  tenant_id: TenantId;
  /** token 唯一 id（撤销追踪）。 */
  jti: string;
  /** 签发时间（秒）。 */
  iat: number;
  /** 过期时间（秒）。 */
  exp: number;
  scope: "widget";
  /**
   * 保留字段，仅用于未来缩小 HTTP control token 的授权范围。
   * WebSocket 已使用独立的 session-scoped 单次 ticket，不消费该 JWT。
   */
  sess?: string;
}

/**
 * widget 鉴权服务。HS256 对称签名（后端单点签发+校验），不依赖 @fastify/jwt 装饰器——
 * WS 握手回调无 Fastify request 上下文，需独立可调的 verify。
 *
 * 用法：
 * - issueToken(app_key)：换 token 端点签发短时 JWT，登记 jti。
 * - requireBearer(request)：HTTP Bearer 校验。
 */
export interface WidgetAuthService {
  /** 校验 app_key + secret；命中未吊销且 hash 匹配返回 app，否则 null。 */
  verifyAppCredentials(app_key: string, secret: string): Promise<WidgetAppCredential | null>;
  issueToken(app: WidgetAppCredential): Promise<{ token: string; expires_at: number }>;
  requireBearer(request: FastifyRequest): Promise<WidgetTokenClaims>;
  verifyPublishableSession(input: { appKey: string; origin: string | undefined }): Promise<WidgetAppCredential>;
}

/** 鉴权失败错误；路由层 catch 后转 HttpError(401)。 */
export class WidgetAuthError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = "WidgetAuthError";
  }
}

export function createWidgetAuthService(keyRing: JwtKeyRing, credentials: WidgetCredentialRepository): WidgetAuthService {

  const sign = (claims: WidgetTokenClaims, key: JwtSigningKey): string => {
    const headerSegment = base64urlJson({ alg: "HS256", typ: "JWT", kid: key.kid });
    const payloadSegment = base64urlJson(claims);
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = createHmac("sha256", key.secret).update(signingInput).digest().toString("base64url");
    return `${signingInput}.${signature}`;
  };

  const verify = async (token: string): Promise<WidgetTokenClaims> => {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new WidgetAuthError("malformed token");
    }
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    if (!headerSegment || !payloadSegment || !signatureSegment) {
      throw new WidgetAuthError("malformed token");
    }
    const signingInput = `${headerSegment}.${payloadSegment}`;
    let header: { alg?: unknown; kid?: unknown };
    try {
      header = parseBase64urlJson(headerSegment) as { alg?: unknown; kid?: unknown };
    } catch {
      throw new WidgetAuthError("invalid header");
    }
    if (header.alg !== "HS256" || (header.kid !== undefined && typeof header.kid !== "string")) {
      throw new WidgetAuthError("invalid header");
    }
    const verificationKey = keyRing.getVerificationKey(header.kid as string | undefined);
    if (!verificationKey) throw new WidgetAuthError("unknown or expired signing key");
    const expected = createHmac("sha256", verificationKey.secret).update(signingInput).digest();
    const actual = Buffer.from(signatureSegment, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new WidgetAuthError("invalid signature");
    }
    const claims = parseBase64urlJson(payloadSegment) as Partial<WidgetTokenClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp < now) {
      throw new WidgetAuthError("token expired");
    }
    if (claims.scope !== "widget") {
      throw new WidgetAuthError("invalid scope");
    }
    if (typeof claims.sub !== "string" || typeof claims.jti !== "string" || typeof claims.tenant_id !== "string") {
      throw new WidgetAuthError("invalid claims");
    }
    const tenantId = createTenantId(claims.tenant_id);
    const resolvedTenantId = await credentials.apps.resolveTenantId(claims.sub);
    if (!resolvedTenantId || resolvedTenantId !== tenantId) {
      throw new WidgetAuthError("invalid tenant");
    }
    if (await credentials.tokens.isRevoked(tenantId, claims.jti)) {
      throw new WidgetAuthError("token revoked");
    }
    const app = await credentials.apps.get(tenantId, claims.sub);
    if (!app || app.revoked_at) {
      throw new WidgetAuthError("app revoked");
    }
    return claims as WidgetTokenClaims;
  };

  return {
    async verifyAppCredentials(app_key, secret) {
      const tenantId = await credentials.apps.resolveTenantId(app_key);
      return tenantId ? await credentials.apps.verifySecret(tenantId, app_key, secret) : null;
    },
    async issueToken(app) {
      const now = Math.floor(Date.now() / 1000);
      const claims: WidgetTokenClaims = {
        sub: app.app_key,
        tenant_id: app.tenant_id,
        jti: randomUUID(),
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
        scope: "widget",
      };
      await credentials.tokens.record({
        tenantId: app.tenant_id,
        jti: claims.jti,
        app_key: app.app_key,
        issued_at: claims.iat,
        expires_at: claims.exp,
      });
      return { token: sign(claims, keyRing.getActiveSigningKey(now)), expires_at: claims.exp };
    },
    async requireBearer(request) {
      const header = request.headers.authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match || !match[1]) {
        throw new WidgetAuthError("missing bearer token");
      }
      return await verify(match[1]);
    },
    async verifyPublishableSession(input) {
      const tenantId = await credentials.apps.resolveTenantId(input.appKey);
      const app = tenantId ? await credentials.apps.get(tenantId, input.appKey) : null;
      if (!app) throw new WidgetAuthError("publishable key 无效");
      if (app.revoked_at) throw new WidgetAuthError("app revoked");
      const origins = app.allowed_origins.split(",").map((origin) => origin.trim()).filter(Boolean);
      if (origins.length === 0) throw new WidgetAuthError("allowed_origins 未配置");
      if (!input.origin) throw new WidgetAuthError("missing origin");
      if (!origins.includes(input.origin)) throw new WidgetAuthError(`origin 不允许: ${input.origin}`);
      return app;
    },
  };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}
