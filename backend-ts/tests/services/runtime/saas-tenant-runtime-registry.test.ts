import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeContainer } from "../../../src/contracts/runtime/runtime-container.js";
import type { SaaSConversationRuntimeHandle } from "../../../src/adapters/saas/composition/saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "../../../src/adapters/saas/composition/saas-memory-runtime.js";

const createRuntime = vi.hoisted(() => vi.fn());
const prepareRuntime = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../../src/adapters/saas/composition/saas-runtime-container.js", () => ({
  createSaaSRuntimeContainer: createRuntime,
  prepareSaaSRuntimeContainer: prepareRuntime,
}));

import { SaaSTenantRuntimeRegistry } from "../../../src/adapters/saas/composition/saas-tenant-runtime-registry.js";
import { buildApp } from "../../../src/app.js";

const registries: SaaSTenantRuntimeRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.closeAll()));
  createRuntime.mockReset();
  prepareRuntime.mockClear();
});

describe("SaaSTenantRuntimeRegistry", () => {
  it("creates tenant runtimes through the SaaS composition root", async () => {
    const initialize = vi.fn(async () => undefined);
    const close = vi.fn();
    const runtime = {
      backgroundTasks: { initialize, setOnTaskCompleted: vi.fn() },
      agentExecution: { listRunningTasks: () => ({ count: 0 }), triggerBgNotificationRun: vi.fn() },
      interactionCoordinator: { runtimeStorage: { tenantId: "tnt_saas" } },
      close,
    } as unknown as RuntimeContainer;
    const conversationRuntime = {
      conversation: { getSession: vi.fn(async () => ({ tenant_id: "tnt_saas" })) },
    } as unknown as SaaSConversationRuntimeHandle;
    const memoryRuntime = {} as SaaSMemoryRuntimeHandle;
    createRuntime.mockReturnValue(runtime);

    const registry = new SaaSTenantRuntimeRegistry(
      { tenantsRoot: "D:/runtime-tenants" } as never,
      {
        get: vi.fn(async () => ({ id: "tnt_saas", status: "active" })),
        list: vi.fn(async () => []),
      } as never,
      conversationRuntime,
      undefined,
      { memoryRuntime },
    );
    registries.push(registry);

    const lease = await registry.acquire("tnt_saas");
    expect(lease.runtime).toBe(runtime);
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tnt_saas",
      dataRoot: expect.stringMatching(/runtime-tenants[\\/]tnt_saas$/),
      conversationRuntime,
      memoryRuntime,
    }));
    expect(initialize).toHaveBeenCalledOnce();
    expect(prepareRuntime).toHaveBeenCalledWith("tnt_saas", runtime, conversationRuntime);
    lease.release();
  });

  it("rejects SaaS composition that could fall back to Local applications", async () => {
    await expect(buildApp({
      env: {} as never,
      saasConversationRuntime: {} as SaaSConversationRuntimeHandle,
      saasMemoryRuntime: {} as SaaSMemoryRuntimeHandle,
    })).rejects.toThrow(/SaaS application composition is incomplete/);
  });

  it("closes a partially initialized SaaS runtime", async () => {
    const close = vi.fn();
    createRuntime.mockReturnValue({
      backgroundTasks: {
        initialize: vi.fn(async () => { throw new Error("background init failed"); }),
        setOnTaskCompleted: vi.fn(),
      },
      close,
    } as unknown as RuntimeContainer);
    const registry = new SaaSTenantRuntimeRegistry(
      { tenantsRoot: "D:/runtime-tenants" } as never,
      { get: vi.fn(async () => ({ id: "tnt_saas", status: "active" })) } as never,
      { conversation: {} } as SaaSConversationRuntimeHandle,
      undefined,
      { memoryRuntime: {} as SaaSMemoryRuntimeHandle },
    );
    registries.push(registry);

    await expect(registry.acquire("tnt_saas")).rejects.toThrow("background init failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
