import type { WidgetCredentialRepository } from "../../../contracts/widget-credentials.js";
import type { WidgetCredentialStore } from "./widget-credential-store/index.js";

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export interface SqliteWidgetCredentialAdapterOptions {
  closeStore?: boolean;
}

/** Async Widget credential boundary backed by the control plane's SQLite tables. */
export class SqliteWidgetCredentialAdapter implements WidgetCredentialRepository {
  readonly apps: WidgetCredentialRepository["apps"];
  readonly tokens: WidgetCredentialRepository["tokens"];
  readonly audit: WidgetCredentialRepository["audit"];
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly closeStore: boolean;

  constructor(
    readonly store: WidgetCredentialStore,
    options: SqliteWidgetCredentialAdapterOptions = {},
  ) {
    this.closeStore = options.closeStore ?? false;
    this.apps = {
      create: async (input) => this.store.ops.createApp(input),
      resolveTenantId: async (appKey) => this.store.ops.resolveTenantId(appKey),
      verifySecret: async (tenantId, appKey, secret) => this.store.ops.verifySecret(tenantId, appKey, secret),
      get: async (tenantId, appKey) => this.store.ops.getApp(tenantId, appKey),
      list: async (tenantId) => this.store.ops.listApps(tenantId),
      update: async (tenantId, appKey, input) => this.store.ops.updateApp(tenantId, appKey, input),
      rotateSecret: async (tenantId, appKey) => this.store.ops.rotateSecret(tenantId, appKey),
      revoke: async (tenantId, appKey) => this.store.ops.revokeApp(tenantId, appKey),
      listAllowedOrigins: async (tenantId) => this.store.ops.listAllowedOrigins(tenantId),
    };
    this.tokens = {
      record: async (input) => this.store.ops.recordToken(input),
      isRevoked: async (tenantId, jti) => this.store.ops.isTokenRevoked(tenantId, jti),
      revoke: async (tenantId, jti) => this.store.ops.revokeToken(tenantId, jti),
      listByApp: async (tenantId, appKey) => this.store.ops.listTokensByApp(tenantId, appKey),
      pruneExpired: async (nowSeconds) => this.store.ops.pruneExpiredTokens(nowSeconds),
    };
    this.audit = {
      record: async (tenantId, input) => this.store.audit.record(tenantId, input),
      list: async (tenantId, appKey, limit, offset) => this.store.audit.list(tenantId, appKey, limit, offset),
    };
  }

  async startPruning(intervalMs = PRUNE_INTERVAL_MS): Promise<void> {
    if (this.pruneTimer) return;
    await this.tokens.pruneExpired(Math.floor(Date.now() / 1000));
    this.pruneTimer = setInterval(() => {
      void this.tokens.pruneExpired(Math.floor(Date.now() / 1000)).catch(() => undefined);
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
    if (this.closeStore) this.store.close();
  }
}
