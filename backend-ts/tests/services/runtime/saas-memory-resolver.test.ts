import { describe, expect, it, vi } from "vitest";

import { createSaaSMemoryApplicationResolver } from "../../../src/adapters/saas/composition/saas-memory-resolver.js";

describe("createSaaSMemoryApplicationResolver", () => {
  it("resolves a resource-free facade for the request tenant", async () => {
    const memory = { query: {}, commands: {}, governance: {} };
    const provider = {
      memoryForTenant: vi.fn(() => memory),
    };
    const resolver = createSaaSMemoryApplicationResolver(provider as never);
    const resolved = await resolver({ identity: { tenantId: "tnt_alpha" } } as never);

    expect(resolved).toBe(memory);
    expect(provider.memoryForTenant).toHaveBeenCalledWith("tnt_alpha");
  });
});
