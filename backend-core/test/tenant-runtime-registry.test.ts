import { describe, expect, it } from "vitest";

import { TenantRuntimeRegistryCore } from "../src/services/runtime/tenant-runtime-registry.js";

describe("TenantRuntimeRegistryCore shutdown", () => {
  it("propagates runtime close failures after attempting every entry", async () => {
    const firstError = new Error("first close failed");
    const secondError = new Error("second close failed");
    const closed: string[] = [];
    const registry = new TenantRuntimeRegistryCore<{ tenantId: string }>(undefined, {
      createRuntime: (tenantId) => ({ tenantId }),
      hasSession: () => false,
      closeRuntime: async (runtime) => {
        closed.push(runtime.tenantId);
        throw runtime.tenantId === "tnt_first" ? firstError : secondError;
      },
    });

    await registry.acquire("tnt_first");
    await registry.acquire("tnt_second");

    const closeError = await registry.closeAll().then(
      () => null,
      (error: unknown) => error,
    );
    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).errors).toEqual(
      expect.arrayContaining([firstError, secondError]),
    );
    expect(closed.sort()).toEqual(["tnt_first", "tnt_second"]);
    expect(registry.snapshot("tnt_first")).toBeNull();
    expect(registry.snapshot("tnt_second")).toBeNull();
  });
});
