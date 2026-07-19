import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { SqliteControlPlaneAdapter, createSqliteControlPlaneAdapter } from "../../src/adapters/local/sqlite-control-plane-adapter.js";
import { createControlStore } from "../../src/adapters/local/sqlite/control-store/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";
import { testEnv } from "../helpers/app.js";

describe("Control Plane composition", () => {
  it("requires the SaaS Control runtime for PostgreSQL mode", async () => {
    await expect(buildApp({
      env: {
        ...testEnv,
        controlStorageMode: "postgres",
        controlDatabaseUrl: "postgres://control/database",
      },
    })).rejects.toThrow("requires SaaSControlRuntime");
  });

  it("rejects a Control Plane that is not backed by the legacy Bot/Widget store", async () => {
    const controlPlane = createSqliteControlPlaneAdapter(makeTempRoot());
    try {
      await expect(buildApp({ env: testEnv, controlPlane })).rejects.toThrow("same SQLite controlStore");
    } finally {
      await controlPlane.close();
    }
  });

  it("closes an owning same-store adapter without double-closing SQLite", async () => {
    const root = makeTempRoot();
    const controlStore = createControlStore(path.join(root, "system"));
    const controlPlane = new SqliteControlPlaneAdapter(controlStore, { closeStore: true });
    const app = await buildApp({
      env: { ...testEnv, dataRoot: root, systemRoot: path.join(root, "system"), tenantsRoot: path.join(root, "tenants") },
      controlStore,
      controlPlane,
    });
    await app.ready();
    await expect(app.close()).resolves.toBeUndefined();
  });
});
