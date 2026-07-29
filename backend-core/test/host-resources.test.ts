import { describe, expect, it } from "vitest";

import {
  findBackendPluginResource,
  requireBackendPluginResource,
} from "../src/plugins/host-resources.js";

describe("backend host resources", () => {
  it("resolves a unique opaque resource", () => {
    const resource = { pluginId: "host", kind: "database", value: { connected: true } };
    expect(findBackendPluginResource<{ connected: boolean }>([resource], "database"))
      .toEqual({ connected: true });
    expect(requireBackendPluginResource([resource], "database")).toEqual({ connected: true });
  });

  it("rejects missing and ambiguous required resources", () => {
    expect(() => requireBackendPluginResource([], "database"))
      .toThrow("Required backend plugin resource 'database' is not available");
    expect(() => findBackendPluginResource([
      { pluginId: "first", kind: "database", value: 1 },
      { pluginId: "second", kind: "database", value: 2 },
    ], "database")).toThrow("Backend plugin resource 'database' has multiple providers");
  });
});
