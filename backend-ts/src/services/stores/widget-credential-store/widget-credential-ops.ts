import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WidgetCredentialDb } from "./db.js";

/** widget 应用记录（持久化形态；secret 仅以 SHA-256 hash 存储，明文不落库）。 */
export interface WidgetApp {
  app_key: string;
  secret_hash: string;
  secret_prefix: string;
  display_name: string;
  /** 逗号分隔的允许来源；空串表示不限（仅靠 env CORS 白名单）。 */
  allowed_origins: string;
  created_at: string;
  revoked_at: string | null;
}

/** createApp 返回；secret 明文仅此一次返回给调用方（CLI/管理端），之后不可再取。 */
export interface CreatedWidgetApp {
  app_key: string;
  secret: string;
  secret_prefix: string;
  display_name: string;
  allowed_origins: string[];
}
export interface WidgetToken { jti: string; app_key: string; issued_at: number; expires_at: number; revoked: boolean; }

/**
 * widget 凭证聚合根操作。
 *
 * - app_key/secret 采用公钥/私钥对模型：app_key 明文作身份（wid_pk_），secret 仅存 hash（wid_sk_）。
 * - verifySecret 用 timingSafeEqual 比对 hash，常量时间防侧信道。
 * - token 记录（jti）用于签发登记 + 撤销追踪；isTokenRevoked 对未知 jti 返回 true（拒绝）。
 */
export class WidgetCredentialOps {
  constructor(private readonly db: WidgetCredentialDb) {}

  createApp(input: { display_name: string; allowed_origins?: string[] }): CreatedWidgetApp {
    const app_key = `wid_pk_${randomBytes(24).toString("hex")}`;
    const secret = `wid_sk_${randomBytes(32).toString("hex")}`;
    const secret_hash = hashSecret(secret);
    const secret_prefix = secret.slice(0, 12);
    const allowed = (input.allowed_origins ?? []).join(",").trim();
    this.db
      .prepare(
        `INSERT INTO widget_apps (app_key, secret_hash, secret_prefix, display_name, allowed_origins)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(app_key, secret_hash, secret_prefix, input.display_name, allowed);
    return {
      app_key,
      secret,
      secret_prefix,
      display_name: input.display_name,
      allowed_origins: input.allowed_origins ?? [],
    };
  }

  /** 校验 app_key + secret；命中未吊销且 hash 匹配返回 app，否则 null。 */
  verifySecret(app_key: string, secret: string): WidgetApp | null {
    const app = this.getApp(app_key);
    if (!app || app.revoked_at) {
      return null;
    }
    const expected = Buffer.from(app.secret_hash, "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }
    return app;
  }

  getApp(app_key: string): WidgetApp | null {
    const row = this.db
      .prepare(
        "SELECT app_key, secret_hash, secret_prefix, display_name, allowed_origins, created_at, revoked_at FROM widget_apps WHERE app_key=?",
      )
      .get(app_key) as WidgetApp | undefined;
    return row ?? null;
  }

  listApps(): WidgetApp[] {
    return this.db.prepare("SELECT app_key, secret_hash, secret_prefix, display_name, allowed_origins, created_at, revoked_at FROM widget_apps ORDER BY created_at DESC, app_key DESC").all() as unknown as WidgetApp[];
  }

  updateApp(app_key: string, input: { display_name?: string; allowed_origins?: string[] }): WidgetApp | null {
    const current = this.getApp(app_key);
    if (!current) return null;
    this.db.prepare("UPDATE widget_apps SET display_name=?, allowed_origins=? WHERE app_key=?").run(input.display_name ?? current.display_name, input.allowed_origins?.join(",") ?? current.allowed_origins, app_key);
    return this.getApp(app_key);
  }

  rotateSecret(app_key: string): CreatedWidgetApp | null {
    const app = this.getApp(app_key);
    if (!app || app.revoked_at) return null;
    const secret = `wid_sk_${randomBytes(32).toString("hex")}`;
    const secret_prefix = secret.slice(0, 12);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE widget_apps SET secret_hash=?, secret_prefix=? WHERE app_key=?").run(hashSecret(secret), secret_prefix, app_key);
      this.revokeAppTokens(app_key);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { app_key, secret, secret_prefix, display_name: app.display_name, allowed_origins: splitOrigins(app.allowed_origins) };
  }

  revokeApp(app_key: string): boolean {
    this.db.exec("BEGIN");
    try {
      const result = this.db.prepare("UPDATE widget_apps SET revoked_at=CURRENT_TIMESTAMP WHERE app_key=? AND revoked_at IS NULL").run(app_key);
      this.revokeAppTokens(app_key);
      this.db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recordToken(input: { jti: string; app_key: string; issued_at: number; expires_at: number }): void {
    this.db
      .prepare("INSERT INTO widget_tokens (jti, app_key, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)")
      .run(input.jti, input.app_key, input.issued_at, input.expires_at);
  }

  /** 未知 jti 视为已撤销（拒绝）——只认本库登记过的 token。 */
  isTokenRevoked(jti: string): boolean {
    const row = this.db.prepare("SELECT revoked FROM widget_tokens WHERE jti=?").get(jti) as
      | { revoked: number }
      | undefined;
    if (!row) {
      return true;
    }
    return Boolean(row.revoked);
  }

  revokeToken(jti: string): void {
    this.db.prepare("UPDATE widget_tokens SET revoked=1 WHERE jti=?").run(jti);
  }

  listTokensByApp(app_key: string): WidgetToken[] {
    const rows = this.db.prepare("SELECT jti, app_key, issued_at, expires_at, revoked FROM widget_tokens WHERE app_key=? ORDER BY issued_at DESC").all(app_key) as unknown as Array<Omit<WidgetToken, "revoked"> & { revoked: number }>;
    return rows.map((row) => ({ ...row, revoked: Boolean(row.revoked) }));
  }

  revokeAppTokens(app_key: string): number {
    return Number(this.db.prepare("UPDATE widget_tokens SET revoked=1 WHERE app_key=? AND revoked=0").run(app_key).changes);
  }

  /** 所有未吊销 app 的 allowed_origins 并集（CORS 白名单叠加用）。 */
  listAllowedOrigins(): string[] {
    const rows = this.db
      .prepare("SELECT allowed_origins FROM widget_apps WHERE revoked_at IS NULL AND allowed_origins != ''")
      .all() as { allowed_origins: string }[];
    const set = new Set<string>();
    for (const row of rows) {
      for (const origin of row.allowed_origins.split(",")) {
        const trimmed = origin.trim();
        if (trimmed) {
          set.add(trimmed);
        }
      }
    }
    return [...set];
  }

  /** 清理已过期 token 记录，避免 widget_tokens 无限增长。 */
  pruneExpiredTokens(nowSeconds: number): number {
    const result = this.db.prepare("DELETE FROM widget_tokens WHERE expires_at < ?").run(nowSeconds);
    return Number(result.changes);
  }
}
function splitOrigins(value: string): string[] { return value.split(",").map((origin) => origin.trim()).filter(Boolean); }

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
