import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createTenantId, createUserId } from "../../../src/identity/types.js";
import {
  CONTROL_LATEST_SCHEMA_VERSION,
  createControlStore,
} from "../../../src/services/stores/control-store/index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ControlStore", () => {
  it("在 systemRoot/control.db 建库并推进独立版本", () => {
    const systemRoot = makeSystemRoot();
    const store = createControlStore(systemRoot);
    store.close();

    const dbPath = path.join(systemRoot, "control.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(CONTROL_LATEST_SCHEMA_VERSION);
    const columns = db.prepare("PRAGMA table_info(widget_apps)").all() as unknown as Array<{ name: string; notnull: number }>;
    expect(columns).toContainEqual(expect.objectContaining({ name: "tenant_id", notnull: 1 }));
    const indexes = db.prepare("PRAGMA index_list(widget_apps)").all() as unknown as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_widget_apps_tenant_id");
    db.close();
  });

  it("支持 Tenant CRUD", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    expect(store.getTenant(tenantId)?.displayName).toBe("Acme");
    expect(store.listTenants()).toHaveLength(1);
    expect(store.updateTenant(tenantId, "Acme China")).toBe(true);
    expect(store.getTenant(tenantId)?.displayName).toBe("Acme China");
    expect(store.deleteTenant(tenantId)).toBe(true);
    expect(store.getTenant(tenantId)).toBeNull();
    store.close();
  });

  it("支持 User CRUD", () => {
    const store = createControlStore(makeSystemRoot());
    const userId = createUserId("usr_alice");
    store.createUser({ id: userId, displayName: "Alice" });
    expect(store.getUser(userId)?.displayName).toBe("Alice");
    expect(store.listUsers()).toHaveLength(1);
    expect(store.updateUser(userId, "Alice Zhang")).toBe(true);
    expect(store.getUser(userId)?.displayName).toBe("Alice Zhang");
    expect(store.deleteUser(userId)).toBe(true);
    expect(store.getUser(userId)).toBeNull();
    store.close();
  });

  it("支持 Membership 新增、改角色、查询和删除", () => {
    const store = createControlStore(makeSystemRoot());
    const tenantId = createTenantId("tnt_acme");
    const userId = createUserId("usr_alice");
    store.createTenant({ id: tenantId, displayName: "Acme" });
    store.createUser({ id: userId, displayName: "Alice" });
    store.upsertMembership({ userId, tenantId, role: "member" });
    expect(store.getMembership(userId, tenantId)?.role).toBe("member");
    store.upsertMembership({ userId, tenantId, role: "admin" });
    expect(store.listMembershipsByTenant(tenantId)).toEqual([{ userId, tenantId, role: "admin" }]);
    expect(store.deleteMembership(userId, tenantId)).toBe(true);
    expect(store.getMembership(userId, tenantId)).toBeNull();
    store.close();
  });
});

function makeSystemRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-control-store-"));
  tempRoots.push(root);
  return path.join(root, "system");
}
