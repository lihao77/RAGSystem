import { describe, expect, it } from "vitest";

import {
  findBackendPluginResource,
  requireBackendPluginResource,
} from "../src/plugins/host-resources.js";
import { createBackendResourceToken, provideBackendResource } from "../src/plugins/resource-registry.js";

describe("backend host resources", () => {
  it("resolves a unique opaque resource", () => {
    const token = createBackendResourceToken<{ connected: boolean }>("database", "test.consumer");
    const resource = provideBackendResource(token, { connected: true }, "host");
    expect(findBackendPluginResource([resource], token))
      .toEqual({ connected: true });
    expect(requireBackendPluginResource([resource], token)).toEqual({ connected: true });
  });

  it("rejects missing and ambiguous required resources", () => {
    const token = createBackendResourceToken<number>("database", "test.consumer");
    expect(() => requireBackendPluginResource([], token))
      .toThrow("Required backend resource 'database' is not available");
    expect(() => findBackendPluginResource([
      provideBackendResource(token, 1, "first"),
      provideBackendResource(token, 2, "second"),
    ], token)).toThrow("Backend resource 'database' has multiple providers");
  });
});
