import { describe, expect, it, vi } from "vitest";

import { createSaaSMemoryApplicationResolver } from "../../../src/app/saas-memory-resolver.js";

describe("createSaaSMemoryApplicationResolver", () => {
  it("resolves the request tenant and releases the provider lease", async () => {
    const release = vi.fn();
    const memory = { query: {}, commands: {}, governance: {} };
    const provider = {
      acquire: vi.fn(async () => ({ tenantId: "tnt_alpha", runtime: { tenantId: "tnt_alpha", memory }, release })),
    };
    const resolver = createSaaSMemoryApplicationResolver(provider as never);
    const resolved = await resolver({ identity: { tenantId: "tnt_alpha" } } as never);

    expect(resolved).toBe(memory);
    expect(provider.acquire).toHaveBeenCalledWith("tnt_alpha");
    expect(release).toHaveBeenCalledOnce();
  });
});
