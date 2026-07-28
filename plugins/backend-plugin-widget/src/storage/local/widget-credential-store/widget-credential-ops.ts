import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createTenantId, type TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { WidgetCredentialDb } from "./db.js";

export interface WidgetApp {
  app_key: string;
  tenant_id: TenantId;
  secret_hash: string;
  secret_prefix: string;
  display_name: string;
  allowed_origins: string;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedWidgetApp {
  app_key: string;
  tenant_id: TenantId;
  secret: string;
  secret_prefix: string;
  display_name: string;
  allowed_origins: string[];
}

export interface WidgetToken {
  jti: string;
  app_key: string;
  issued_at: number;
  expires_at: number;
  revoked: boolean;
}

export class WidgetCredentialOps {
  constructor(private readonly db: WidgetCredentialDb) {}

  createApp(input: { tenantId: TenantId; display_name: string; allowed_origins?: string[] }): CreatedWidgetApp {
    const appKey = `wid_pk_${randomBytes(24).toString("hex")}`;
    const secret = `wid_sk_${randomBytes(32).toString("hex")}`;
    const secretPrefix = secret.slice(0, 12);
    const allowedOrigins = (input.allowed_origins ?? []).join(",").trim();
    this.db.prepare(`
      INSERT INTO widget_apps (
        app_key, tenant_id, secret_hash, secret_prefix, display_name, allowed_origins
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(appKey, input.tenantId, hashSecret(secret), secretPrefix, input.display_name, allowedOrigins);
    return {
      app_key: appKey,
      tenant_id: input.tenantId,
      secret,
      secret_prefix: secretPrefix,
      display_name: input.display_name,
      allowed_origins: input.allowed_origins ?? [],
    };
  }

  resolveTenantId(appKey: string): TenantId | null {
    const row = this.db.prepare("SELECT tenant_id FROM widget_apps WHERE app_key=?").get(appKey) as
      | { tenant_id: string }
      | undefined;
    return row ? createTenantId(row.tenant_id) : null;
  }

  verifySecret(tenantId: TenantId, appKey: string, secret: string): WidgetApp | null {
    const app = this.getApp(tenantId, appKey);
    if (!app || app.revoked_at) return null;
    const expected = Buffer.from(app.secret_hash, "hex");
    const actual = Buffer.from(hashSecret(secret), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? app : null;
  }

  getApp(tenantId: TenantId, appKey: string): WidgetApp | null {
    const row = this.db.prepare(`
      SELECT app_key, tenant_id, secret_hash, secret_prefix, display_name, allowed_origins, created_at, revoked_at
      FROM widget_apps
      WHERE tenant_id=? AND app_key=?
    `).get(tenantId, appKey) as WidgetApp | undefined;
    return row ?? null;
  }

  listApps(tenantId: TenantId): WidgetApp[] {
    return this.db.prepare(`
      SELECT app_key, tenant_id, secret_hash, secret_prefix, display_name, allowed_origins, created_at, revoked_at
      FROM widget_apps
      WHERE tenant_id=?
      ORDER BY created_at DESC, app_key DESC
    `).all(tenantId) as unknown as WidgetApp[];
  }

  updateApp(tenantId: TenantId, appKey: string, input: { display_name?: string; allowed_origins?: string[] }): WidgetApp | null {
    const current = this.getApp(tenantId, appKey);
    if (!current) return null;
    this.db.prepare(`
      UPDATE widget_apps
      SET display_name=?, allowed_origins=?
      WHERE tenant_id=? AND app_key=?
    `).run(
      input.display_name ?? current.display_name,
      input.allowed_origins?.join(",") ?? current.allowed_origins,
      tenantId,
      appKey,
    );
    return this.getApp(tenantId, appKey);
  }

  rotateSecret(tenantId: TenantId, appKey: string): CreatedWidgetApp | null {
    const app = this.getApp(tenantId, appKey);
    if (!app || app.revoked_at) return null;
    const secret = `wid_sk_${randomBytes(32).toString("hex")}`;
    const secretPrefix = secret.slice(0, 12);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE widget_apps
        SET secret_hash=?, secret_prefix=?
        WHERE tenant_id=? AND app_key=?
      `).run(hashSecret(secret), secretPrefix, tenantId, appKey);
      this.revokeAppTokens(tenantId, appKey);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      app_key: appKey,
      tenant_id: tenantId,
      secret,
      secret_prefix: secretPrefix,
      display_name: app.display_name,
      allowed_origins: splitOrigins(app.allowed_origins),
    };
  }

  revokeApp(tenantId: TenantId, appKey: string): boolean {
    this.db.exec("BEGIN");
    try {
      const result = this.db.prepare(`
        UPDATE widget_apps
        SET revoked_at=CURRENT_TIMESTAMP
        WHERE tenant_id=? AND app_key=? AND revoked_at IS NULL
      `).run(tenantId, appKey);
      this.revokeAppTokens(tenantId, appKey);
      this.db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordToken(input: { tenantId: TenantId; jti: string; app_key: string; issued_at: number; expires_at: number }): void {
    const result = this.db.prepare(`
      INSERT INTO widget_tokens (jti, app_key, issued_at, expires_at, revoked)
      SELECT ?, app_key, ?, ?, 0
      FROM widget_apps
      WHERE tenant_id=? AND app_key=?
    `).run(input.jti, input.issued_at, input.expires_at, input.tenantId, input.app_key);
    if (Number(result.changes) !== 1) throw new Error("widget app 不存在");
  }

  isTokenRevoked(tenantId: TenantId, jti: string): boolean {
    const row = this.db.prepare(`
      SELECT token.revoked
      FROM widget_tokens token
      JOIN widget_apps app ON app.app_key=token.app_key
      WHERE app.tenant_id=? AND token.jti=?
    `).get(tenantId, jti) as { revoked: number } | undefined;
    return row ? Boolean(row.revoked) : true;
  }

  revokeToken(tenantId: TenantId, jti: string): boolean {
    const result = this.db.prepare(`
      UPDATE widget_tokens
      SET revoked=1
      WHERE jti=? AND app_key IN (SELECT app_key FROM widget_apps WHERE tenant_id=?)
    `).run(jti, tenantId);
    return Number(result.changes) > 0;
  }

  listTokensByApp(tenantId: TenantId, appKey: string): WidgetToken[] {
    const rows = this.db.prepare(`
      SELECT token.jti, token.app_key, token.issued_at, token.expires_at, token.revoked
      FROM widget_tokens token
      JOIN widget_apps app ON app.app_key=token.app_key
      WHERE app.tenant_id=? AND token.app_key=?
      ORDER BY token.issued_at DESC
    `).all(tenantId, appKey) as unknown as Array<Omit<WidgetToken, "revoked"> & { revoked: number }>;
    return rows.map((row) => ({ ...row, revoked: Boolean(row.revoked) }));
  }

  revokeAppTokens(tenantId: TenantId, appKey: string): number {
    return Number(this.db.prepare(`
      UPDATE widget_tokens
      SET revoked=1
      WHERE app_key=? AND revoked=0
        AND app_key IN (SELECT app_key FROM widget_apps WHERE tenant_id=?)
    `).run(appKey, tenantId).changes);
  }

  listAllowedOrigins(tenantId: TenantId): string[] {
    const rows = this.db.prepare(`
      SELECT allowed_origins
      FROM widget_apps
      WHERE tenant_id=? AND revoked_at IS NULL AND allowed_origins != ''
    `).all(tenantId) as unknown as { allowed_origins: string }[];
    const origins = new Set<string>();
    for (const row of rows) {
      for (const origin of splitOrigins(row.allowed_origins)) origins.add(origin);
    }
    return [...origins];
  }

  pruneExpiredTokens(nowSeconds: number): number {
    return Number(this.db.prepare("DELETE FROM widget_tokens WHERE expires_at < ?").run(nowSeconds).changes);
  }
}

function splitOrigins(value: string): string[] {
  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
