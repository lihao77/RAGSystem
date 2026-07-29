#!/usr/bin/env tsx
/**
 * widget 应用凭证管理 CLI：创建/吊销 widget app（app-key/secret 对）。
 *
 * 用法（位置参数——避免 npm/npx 吞 --flag）：
 *   npm -w @ragsystem/backend-plugin-widget run widget-app -- create <名称> [来源1,来源2,...]
 *   npm -w @ragsystem/backend-plugin-widget run widget-app -- revoke <app_key>
 *
 * 例：
 *   npm -w @ragsystem/backend-plugin-widget run widget-app -- create demo http://localhost:4321
 *
 * create 成功后 secret 仅显示一次——后端只存 SHA-256 hash，无法找回，请立即保存。
 */
import { loadEnv } from "@ragsystem/backend-core/config/env.js";
import { LOCAL_TENANT_ID } from "@ragsystem/backend-core/services/identity/index.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SqliteWidgetCredentialAdapter } from "../storage/local/sqlite-widget-credential-adapter.js";
import { createWidgetCredentialStore } from "../storage/local/widget-credential-store/index.js";

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (!["create", "revoke", "list", "rotate", "update-origin"].includes(command ?? "")) {
    usage();
    process.exit(1);
  }

  const env = loadEnv(process.env);
  const database = new DatabaseSync(path.join(env.systemRoot, "control.db"));
  database.exec("PRAGMA foreign_keys = ON");
  assertLocalTenantExists(database);
  const store = createWidgetCredentialStore(database);
  const widgetCredentials = new SqliteWidgetCredentialAdapter(store);
  try {
    if (command === "create") {
      const name = rest[0];
      if (!name) {
        usage();
        process.exit(1);
      }
      const origins = (rest[1] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const created = await widgetCredentials.apps.create({ tenantId: LOCAL_TENANT_ID, display_name: name, allowed_origins: origins });
      console.log(JSON.stringify(created, null, 2));
      console.error("\n⚠️  secret 仅此一次显示，请立即保存（后端只存 hash）。");
    } else if (command === "revoke") {
      const appKey = rest[0];
      if (!appKey) {
        usage();
        process.exit(1);
      }
      const ok = await widgetCredentials.apps.revoke(LOCAL_TENANT_ID, appKey);
      console.log(ok ? `已吊销 ${appKey}` : `未找到或已吊销：${appKey}`);
    } else if (command === "list") {
      console.log(JSON.stringify((await widgetCredentials.apps.list(LOCAL_TENANT_ID)).map(({ secret_hash: _secretHash, ...app }) => app), null, 2));
    } else if (command === "rotate") {
      const appKey = rest[0]; if (!appKey) { usage(); process.exit(1); }
      const rotated = await widgetCredentials.apps.rotateSecret(LOCAL_TENANT_ID, appKey);
      console.log(rotated ? JSON.stringify(rotated, null, 2) : `未找到或已吊销：${appKey}`);
      if (rotated) console.error("\n⚠️  secret 仅此一次显示，请立即保存。");
    } else {
      const appKey = rest[0]; if (!appKey) { usage(); process.exit(1); }
      const origins = (rest[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      const updated = await widgetCredentials.apps.update(LOCAL_TENANT_ID, appKey, { allowed_origins: origins });
      console.log(updated ? JSON.stringify({ ...updated, secret_hash: undefined }, null, 2) : `未找到：${appKey}`);
    }
  } finally {
    await widgetCredentials.close();
    store.close();
    database.close();
  }
}

function assertLocalTenantExists(database: DatabaseSync): void {
  try {
    const tenant = database.prepare("SELECT 1 AS present FROM tenants WHERE id=?").get(LOCAL_TENANT_ID);
    if (tenant) return;
  } catch (error) {
    throw new Error("Local control database is not initialized; start backend-local once before using the Widget CLI", { cause: error });
  }
  throw new Error(`Local tenant '${LOCAL_TENANT_ID}' does not exist; start backend-local once before using the Widget CLI`);
}

function usage(): void {
  console.error(
    [
      "用法（位置参数）:",
      "  create <名称> [来源1,来源2,...]   例: create demo http://localhost:4321",
      "  revoke <app_key>",
      "  list",
      "  rotate <app_key>",
      "  update-origin <app_key> <来源1,来源2,...>",
    ].join("\n"),
  );
}

void main();
