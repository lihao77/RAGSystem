import { describe, expect, it, vi } from "vitest";

import type { BackendPluginModule, InstalledBackendPluginSpec } from "../src/plugins/backend-plugin.js";
import { loadBackendPlugins } from "../src/plugins/plugin-loader.js";

describe("loadBackendPlugins", () => {
  it("imports only enabled modules and passes opaque configuration to the module", async () => {
    const create = vi.fn((input: { config: unknown }) => plugin("example", "1.0.0", input.config));
    const importModule = vi.fn(async (specifier: string) => ({
      backendPluginModule: pluginModule("example", "1.0.0", create),
      specifier,
    }));
    const specs: InstalledBackendPluginSpec[] = [
      { module: " disabled ", enabled: false },
      { module: " example-module ", config: { enabled: true } },
    ];

    const loaded = await loadBackendPlugins(specs, { importModule });

    expect(importModule).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledWith("example-module");
    expect(create).toHaveBeenCalledWith({ config: { enabled: true } });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.id).toBe("example");
  });

  it("rejects missing exports and unsupported API versions", async () => {
    await expect(loadBackendPlugins([{ module: "missing" }], {
      importModule: async () => ({}),
    })).rejects.toThrow("missing 'backendPluginModule' export");

    await expect(loadBackendPlugins([{ module: "future" }], {
      importModule: async () => ({
        backendPluginModule: { apiVersion: 2, manifest: { id: "future", version: "1.0.0" }, create: vi.fn() },
      }),
    })).rejects.toThrow("unsupported apiVersion '2'");
  });

  it("rejects plugin instances that do not match their module manifest", async () => {
    await expect(loadBackendPlugins([{ module: "mismatch" }], {
      importModule: async () => ({
        backendPluginModule: pluginModule("declared", "1.0.0", () => plugin("created", "1.0.0")),
      }),
    })).rejects.toThrow("created plugin id 'created' does not match module id 'declared'");
  });

  it("preserves import and creation failures as causes", async () => {
    const importFailure = new Error("module not installed");
    const importPromise = loadBackendPlugins([{ module: "missing-package" }], {
      importModule: async () => { throw importFailure; },
    });
    await expect(importPromise).rejects.toMatchObject({ cause: importFailure });

    const createFailure = new Error("invalid config");
    const createPromise = loadBackendPlugins([{ module: "broken-config" }], {
      importModule: async () => ({
        backendPluginModule: pluginModule("broken", "1.0.0", () => { throw createFailure; }),
      }),
    });
    await expect(createPromise).rejects.toMatchObject({ cause: createFailure });
  });
});

function pluginModule(
  id: string,
  version: string,
  create: BackendPluginModule["create"],
): BackendPluginModule {
  return { apiVersion: 1, manifest: { id, version }, create };
}

function plugin(id: string, version: string, config?: unknown) {
  return {
    manifest: { id, version },
    register: vi.fn(),
    config,
  };
}
