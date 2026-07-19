import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AppEnv } from "../../../src/config/env.js";
import { SqliteControlPlaneAdapter } from "../../../src/adapters/local/sqlite-control-plane-adapter.js";
import { createTenantId, createUserId } from "../../../src/identity/types.js";
import { LOCAL_TENANT_ID } from "../../../src/services/identity/index.js";
import { createLocalRuntimeContainer } from "../../../src/adapters/local/runtime-container.js";
import type { RuntimeContainerOptions } from "../../../src/adapters/local/runtime-options.js";
import { DefaultTenantRuntimeRegistry } from "../../../src/services/runtime/tenant-runtime-registry.js";
import { createControlStore } from "../../../src/services/stores/control-store/index.js";
import { HashFallbackEmbedder } from "../../../src/services/integrations/embedder-registry.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

const TENANT_A = createTenantId("tnt_a");
const TENANT_B = createTenantId("tnt_b");

describe("TenantRuntimeRegistry 多租户隔离", () => {
  it("拒绝 suspended tenant 的业务 acquire，但允许平台只读检查", async () => {
    const harness = createRegistryHarness();
    harness.controlStore.setTenantStatus(TENANT_A, "suspended");
    await expect(harness.registry.acquire(TENANT_A)).rejects.toThrow("租户已暂停");
    const inspection = await harness.registry.acquireForInspection(TENANT_A);
    inspection.release();
    await harness.registry.closeAll();
    harness.controlStore.close();
  });

  it("全局反查并注销 daemon routeToken", async () => {
    const harness = createRegistryHarness();
    const botId = createUserId("usr_bot_route");
    harness.registry.registerRouteToken(TENANT_A, botId, "route-token");
    expect(harness.registry.resolveRouteToken("route-token")).toEqual({ tenantId: TENANT_A, botId });
    harness.registry.unregisterRouteToken("route-token", TENANT_A);
    expect(harness.registry.resolveRouteToken("route-token")).toBeNull();
    await harness.registry.closeAll();
    harness.controlStore.close();
  });

  it("为两个租户创建独立目录、数据库与同名资源", async () => {
    const harness = createRegistryHarness();
    const [leaseA, leaseB] = await Promise.all([harness.registry.acquire(TENANT_A), harness.registry.acquire(TENANT_B)]);
    try {
      expect(leaseA.runtime).not.toBe(leaseB.runtime);
      expect(leaseA.runtime.dataRoot).toBe(path.join(harness.env.tenantsRoot, TENANT_A));
      expect(leaseB.runtime.dataRoot).toBe(path.join(harness.env.tenantsRoot, TENANT_B));

      leaseA.runtime.sessionApplication.createSession({ tenantId: TENANT_A, userId: "usr_local", sessionId: "same-session" });
      leaseB.runtime.sessionApplication.createSession({ tenantId: TENANT_B, userId: "usr_local", sessionId: "same-session" });
      leaseA.runtime.agentConfig.createTeam("same-team", "default");
      leaseB.runtime.agentConfig.createTeam("same-team", "default");
      leaseA.runtime.agentConfig.createAgent({ agent_name: "same_agent", default_entry: false });
      leaseB.runtime.agentConfig.createAgent({ agent_name: "same_agent", default_entry: false });

      expect(leaseA.runtime.sessionApplication.getSession("same-session")?.tenant_id).toBe(TENANT_A);
      expect(leaseB.runtime.sessionApplication.getSession("same-session")?.tenant_id).toBe(TENANT_B);
      expect(leaseA.runtime.agentConfig.listTeams().teams.map((team) => team.team_name)).toContain("same-team");
      expect(leaseB.runtime.agentConfig.listTeams().teams.map((team) => team.team_name)).toContain("same-team");
      expect(fs.existsSync(path.join(harness.env.tenantsRoot, TENANT_A, "db", "ragsystem.db"))).toBe(true);
      expect(fs.existsSync(path.join(harness.env.tenantsRoot, TENANT_B, "db", "ragsystem.db"))).toBe(true);
    } finally {
      leaseA.release();
      leaseB.release();
      await harness.registry.closeAll();
      harness.controlStore.close();
    }
  });

  it("租户 A 无法读取只存在于租户 B 的会话", async () => {
    const harness = createRegistryHarness();
    const leaseA = await harness.registry.acquire(TENANT_A);
    const leaseB = await harness.registry.acquire(TENANT_B);
    try {
      leaseB.runtime.sessionApplication.createSession({ tenantId: TENANT_B, userId: "usr_local", sessionId: "tenant-b-only" });
      expect(leaseA.runtime.sessionApplication.getSession("tenant-b-only")).toBeNull();
      expect(leaseB.runtime.sessionApplication.getSession("tenant-b-only")?.tenant_id).toBe(TENANT_B);
    } finally {
      leaseA.release();
      leaseB.release();
      await harness.registry.closeAll();
      harness.controlStore.close();
    }
  });

  it("并发 acquire 共享初始化并正确维护引用与 WS 活动", async () => {
    let createCount = 0;
    const harness = createRegistryHarness({
      idleTimeoutMs: 0,
      runtimeFactory: (options) => {
        createCount += 1;
        return createTestRuntime(options);
      },
    });
    const leases = await Promise.all(Array.from({ length: 8 }, () => harness.registry.acquire(TENANT_A)));
    expect(createCount).toBe(1);
    expect(new Set(leases.map((lease) => lease.runtime)).size).toBe(1);
    expect(harness.registry.snapshot(TENANT_A)?.references).toBe(8);

    const ws = harness.registry.trackWebSocket(TENANT_A);
    for (const lease of leases) lease.release();
    await Promise.resolve();
    expect(harness.registry.snapshot(TENANT_A)).toMatchObject({ references: 0, webSockets: 1, state: "ready" });
    ws.release();
    await waitFor(() => harness.registry.snapshot(TENANT_A) === null);
    expect(createCount).toBe(1);
    await harness.registry.closeAll();
    harness.controlStore.close();
  });

  it("prepares the tenant runtime before every lease is returned", async () => {
    let prepareCount = 0;
    const harness = createRegistryHarness({
      prepareRuntime: async (tenantId, runtime) => {
        prepareCount += 1;
        runtime.modelAdapter.replaceRuntimeProviders([{
          key: `${tenantId}_openai_chat`,
          name: tenantId,
          provider_type: "openai_chat",
          api_key: "sk-runtime",
          model_map: { chat: "gpt-runtime" },
          models: ["gpt-runtime"],
          is_loaded: true,
        }]);
      },
    });
    const first = await harness.registry.acquire(TENANT_A);
    expect(first.runtime.modelAdapter.listProviders()[0]).toMatchObject({
      key: "tnt_a_openai_chat",
      api_key: "sk-runtime",
      models: ["gpt-runtime"],
    });
    const projected = first.runtime.runtimeCore.resolveExecutionConfig({
      selectedLlm: "tnt_a|openai_chat|gpt-runtime",
    });
    expect(projected.provider).toMatchObject({
      key: "tnt_a_openai_chat",
      api_key: "sk-runtime",
      model_map: { chat: "gpt-runtime" },
    });
    expect(projected.readiness.provider).toMatchObject({
      configured: true,
      model_available: true,
      api_key_configured: true,
    });
    first.release();
    const second = await harness.registry.acquire(TENANT_A);
    second.release();
    expect(prepareCount).toBe(2);
    await harness.registry.closeAll();
    harness.controlStore.close();
  });

  it("RealtimeEventHub 与事件历史不跨租户", async () => {
    const harness = createRegistryHarness();
    const leaseA = await harness.registry.acquire(TENANT_A);
    const leaseB = await harness.registry.acquire(TENANT_B);
    try {
      leaseA.runtime.realtimeEvents.publish("same-session", { type: "run_started", session_id: "same-session", run_id: "run-a", payload: {} });
      expect(leaseA.runtime.realtimeEvents.getHistory("same-session")).toHaveLength(1);
      expect(leaseB.runtime.realtimeEvents.getHistory("same-session")).toHaveLength(0);
    } finally {
      leaseA.release();
      leaseB.release();
      await harness.registry.closeAll();
      harness.controlStore.close();
    }
  });

  it("Local 模式通过 tnt_local 完成 acquire/release", async () => {
    const harness = createRegistryHarness({ localOnly: true });
    const lease = await harness.registry.acquire(LOCAL_TENANT_ID);
    expect(lease.runtime.dataRoot).toBe(path.join(harness.env.tenantsRoot, LOCAL_TENANT_ID));
    expect(harness.registry.forTenant(LOCAL_TENANT_ID)).toBe(lease.runtime);
    lease.release();
    expect(harness.registry.snapshot(LOCAL_TENANT_ID)?.references).toBe(0);
    await harness.registry.closeAll();
    harness.controlStore.close();
  });
});

function createRegistryHarness(options: {
  idleTimeoutMs?: number;
  localOnly?: boolean;
  runtimeFactory?: (options: RuntimeContainerOptions) => ReturnType<typeof createLocalRuntimeContainer>;
  prepareRuntime?: import("../../../src/services/runtime/tenant-runtime-registry.js").LocalTenantRuntimeRegistryOptions["prepareRuntime"];
} = {}) {
  const dataRoot = makeTempRoot();
  const env: AppEnv = {
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    corsOrigins: true,
    dataRoot,
    tenantsRoot: path.join(dataRoot, "tenants"),
    systemRoot: path.join(dataRoot, "system"),
    tenancyMode: options.localOnly ? "single" : "multi",
    allowUnsafeLocalExecution: false,
    postgresPoolMax: 10,
  };
  const controlStore = createControlStore(env.systemRoot);
  const controlPlane = new SqliteControlPlaneAdapter(controlStore);
  const tenantIds = options.localOnly ? [LOCAL_TENANT_ID] : [TENANT_A, TENANT_B];
  for (const tenantId of tenantIds) controlStore.createTenant({ id: tenantId, displayName: tenantId });
  const registry = new DefaultTenantRuntimeRegistry(env, controlPlane.tenants, undefined, {
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    sweepIntervalMs: 5,
    runtimeFactory: options.runtimeFactory ?? createTestRuntime,
    prepareRuntime: options.prepareRuntime,
  });
  return { env, controlStore, registry };
}

function createTestRuntime(options: RuntimeContainerOptions) {
  return createLocalRuntimeContainer({
    ...options,
    modelAdapterProvidersConfigPath: "",
    mcpConfigPath: "",
    systemConfigPath: "",
    startOutboxDispatcher: false,
    embedderFactory: () => new HashFallbackEmbedder(),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
