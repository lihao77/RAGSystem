import { describe, expect, it } from "vitest";

import type { ISystemConfigStore } from "../src/contracts/runtime/system-config-store.js";
import type { SystemConfigData } from "../src/contracts/runtime/system-config.js";
import { SystemConfigService } from "../src/services/config/system-config-service.js";

class MemorySystemConfigStore implements ISystemConfigStore {
  constructor(private value: SystemConfigData | null = null) {}

  async load(): Promise<SystemConfigData | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(config: SystemConfigData): Promise<void> {
    this.value = structuredClone(config);
  }
}

describe("system config extension lifecycle", () => {
  it("removes an extension from schema and config when it is unregistered", async () => {
    const service = new SystemConfigService(new MemorySystemConfigStore());
    await service.initialize();
    const unregister = service.registerExtension("plugin-a", {
      defaults: { plugin_a: { enabled: true } },
      groups: [{ key: "plugin_a", label: "Plugin A", description: "", fields: [] }],
    });

    expect(service.getSchema().groups.some((group) => group.key === "plugin_a")).toBe(true);
    expect(service.getConfig()).toHaveProperty("plugin_a.enabled", true);

    unregister();

    expect(service.getSchema().groups.some((group) => group.key === "plugin_a")).toBe(false);
    expect(service.getConfig()).not.toHaveProperty("plugin_a");
    expect(service.getSection("plugin_a")).toBeUndefined();
  });

  it("reprojects persisted extension values when the extension is registered again", async () => {
    const store = new MemorySystemConfigStore({ plugin_a: { enabled: false } });
    const service = new SystemConfigService(store);
    await service.initialize();

    expect(service.getSection("plugin_a")).toBeUndefined();
    service.registerExtension("plugin-a", {
      defaults: { plugin_a: { enabled: true } },
      groups: [{ key: "plugin_a", label: "Plugin A", description: "", fields: [] }],
    });

    expect(service.getSection("plugin_a")).toEqual({ enabled: false });
  });

  it("tags extension groups with sourceExtension while builtin groups stay untagged", async () => {
    const service = new SystemConfigService(new MemorySystemConfigStore());
    await service.initialize();
    service.registerExtension("plugin-a", {
      defaults: { plugin_a: { enabled: true } },
      groups: [{ key: "plugin_a", label: "Plugin A", description: "", fields: [] }],
    });

    const groups = service.getSchema().groups;
    const pluginGroup = groups.find((group) => group.key === "plugin_a");
    expect(pluginGroup?.sourceExtension).toBe("plugin-a");
    for (const group of groups.filter((item) => item.key !== "plugin_a")) {
      expect(group.sourceExtension).toBeUndefined();
    }
  });
});
