import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

import type { WidgetCredentialOps, WidgetApp } from "../stores/widget-credential-store/widget-credential-ops.js";

/** widget 短时 token 的 TTL（秒）。 */
const TOKEN_TTL_SECONDS = 15 * 60;

export interface WidgetTokenClaims {
  /** app_key（主体）。 */
  sub: string;
  /** token 唯一 id（撤销追踪）。 */
  jti: string;
  /** 签发时间（秒）。 */
  iat: number;
  /** 过期时间（秒）。 */
  exp: number;
  scope: "widget";
  /**
   * 可选：绑定特定 session_id（per-session 强绑定）。
   * 当前签发/校验未启用 sess——token 复用窗口 = TTL(15min)：一个 token 可连同一 app 的任一会话。
   * per-session 强绑定需 /sessions 端点换发带 sess 的 token（签发 + WS 校验比对），本期未做。
   */
  sess?: string;
}

/**
 * widget 鉴权服务。HS256 对称签名（后端单点签发+校验），不依赖 @fastify/jwt 装饰器——
 * WS 握手回调无 Fastify request 上下文，需独立可调的 verify。
 *
 * 用法：
 * - issueToken(app_key)：换 token 端点签发短时 JWT，登记 jti。
 * - verifyWsToken(token)：WS 握手校验（签名 + exp + jti 未撤销）。
 * - requireBearer(request)：HTTP Bearer 校验。
 * - isOriginAllowed(origin, fallback)：CORS 白名单（env 白名单 ∪ app.allowed_origins）。
 */
export interface WidgetAuthService {
  /** 校验 app_key + secret；命中未吊销且 hash 匹配返回 app，否则 null。 */
  verifyAppCredentials(app_key: string, secret: string): WidgetApp | null;
  issueToken(app_key: string): { token: string; expires_at: number };
  verifyWsToken(token: string | undefined): WidgetTokenClaims;
  requireBearer(request: FastifyRequest): WidgetTokenClaims;
  verifyPublishableSession(input: { appKey: string; origin: string | undefined }): WidgetApp;
  isOriginAllowed(origin: string | undefined, fallback: string[] | boolean): boolean;
}

/** 鉴权失败错误；路由层 catch 后转 HttpError(401)。 */
export class WidgetAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WidgetAuthError";
  }
}

export function createWidgetAuthService(secret: string, credentialOps: WidgetCredentialOps): WidgetAuthService {
  if (!secret || secret.length < 32) {
    throw new Error("WIDGET_JWT_SECRET 至少需 32 字符");
  }
  const key = Buffer.from(secret, "utf8");

  const sign = (claims: WidgetTokenClaims): string => {
    const headerSegment = base64urlJson({ alg: "HS256", typ: "JWT" });
    const payloadSegment = base64urlJson(claims);
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = createHmac("sha256", key).update(signingInput).digest().toString("base64url");
    return `${signingInput}.${signature}`;
  };

  const verify = (token: string): WidgetTokenClaims => {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new WidgetAuthError("malformed token");
    }
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    if (!headerSegment || !payloadSegment || !signatureSegment) {
      throw new WidgetAuthError("malformed token");
    }
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const expected = createHmac("sha256", key).update(signingInput).digest();
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
    if (typeof claims.sub !== "string" || typeof claims.jti !== "string") {
      throw new WidgetAuthError("invalid claims");
    }
    if (credentialOps.isTokenRevoked(claims.jti)) {
      throw new WidgetAuthError("token revoked");
    }
    const app = credentialOps.getApp(claims.sub);
    if (!app || app.revoked_at) {
      throw new WidgetAuthError("app revoked");
    }
    return claims as WidgetTokenClaims;
  };

  return {
    verifyAppCredentials(app_key, secret) {
      return credentialOps.verifySecret(app_key, secret);
    },
    issueToken(app_key) {
      const now = Math.floor(Date.now() / 1000);
      const claims: WidgetTokenClaims = {
        sub: app_key,
        jti: randomUUID(),
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
        scope: "widget",
      };
      credentialOps.recordToken({ jti: claims.jti, app_key, issued_at: claims.iat, expires_at: claims.exp });
      return { token: sign(claims), expires_at: claims.exp };
    },
    verifyWsToken(token) {
      if (!token) {
        throw new WidgetAuthError("missing token");
      }
      return verify(token);
    },
    requireBearer(request) {
      const header = request.headers.authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match || !match[1]) {
        throw new WidgetAuthError("missing bearer token");
      }
      return verify(match[1]);
    },
    verifyPublishableSession(input) {
      const app = credentialOps.getApp(input.appKey);
      if (!app) throw new WidgetAuthError("publishable key 无效");
      if (app.revoked_at) throw new WidgetAuthError("app revoked");
      const origins = app.allowed_origins.split(",").map((origin) => origin.trim()).filter(Boolean);
      if (origins.length === 0) throw new WidgetAuthError("allowed_origins 未配置");
      if (!input.origin) throw new WidgetAuthError("missing origin");
      if (!origins.includes(input.origin)) throw new WidgetAuthError(`origin 不允许: ${input.origin}`);
      return app;
    },
    isOriginAllowed(origin, fallback) {
      // 边界说明（勿高估 allowed_origins 的隔离作用）：
      // 鉴权主链路是嵌入方【服务端】持 secret 调 /auth/token + /sessions——这两步无 Origin 头
      // （!origin → true），CORS 根本不 gate；浏览器只持 token 开 WS（WS 不受 CORS 约束）。
      // 故真正的鉴权大门是 server-held secret，allowed_origins 仅在浏览器后续带 Origin 的请求
      // （如 widget 内部 fetch）时起辅助作用。per-app allowed_origins 非有效隔离边界。
      // 无 Origin（同源 / 非浏览器请求）一律放行，与 CORS 通行行为一致。
      if (!origin) {
        return true;
      }
      // env 全开（CORS_ORIGINS 未设）保持现有行为，不因 widget 收紧。
      if (fallback === true) {
        return true;
      }
      if (Array.isArray(fallback) && fallback.includes(origin)) {
        return true;
      }
      return credentialOps.listAllowedOrigins().includes(origin);
    },
  };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}
