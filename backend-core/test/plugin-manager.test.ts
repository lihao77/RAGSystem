import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  BackendPlugin,
  BackendPluginRuntimeContext,
  BackendSkillSourceContribution,
} from "../src/plugins/backend-plugin.js";
import { createCapability, provideCapability } from "../src/plugins/capability-registry.js";
import { BackendPluginManager } from "../src/plugins/plugin-manager.js";

describe("BackendPluginManager", () => {
  it("orders dependencies and stops plugins in reverse", async () => {
    const events: string[] = [];
    const dependency = plugin("dependency", events);
    const consumer = plugin("consumer", events, ["dependency"]);
    const manager = new BackendPluginManager([consumer, dependency]);

    await manager.register();
    await manager.start();
    await manager.stop();

    expect(events).toEqual([
      "register:dependency",
      "register:consumer",
      "start:dependency",
      "start:consumer",
      "stop:consumer",
      "stop:dependency",
    ]);
  });

  it("rejects missing dependencies and duplicate route ownership", async () => {
    expect(() => new BackendPluginManager([plugin("consumer", [], ["missing"])]))
      .toThrow("Required plugin 'missing' is not installed");

    const manager = new BackendPluginManager([
      routePlugin("first", "/api/example"),
      routePlugin("second", "/api/example"),
    ]);
    await expect(manager.register()).rejects.toThrow(
      "Route contribution 'tenant:/api/example' is already registered",
    );
  });

  it("provides typed capabilities and rejects duplicate providers", () => {
    const token = createCapability<{ enabled: boolean }>("example.config");
    const manager = new BackendPluginManager([], [provideCapability(token, { enabled: true }, "test")]);

    expect(manager.capabilities.require(token)).toEqual({ enabled: true });
    expect(() => manager.capabilities.provide(token, { enabled: false })).toThrow(
      "Capability 'example.config' is already provided by test",
    );
  });

  it("injects registered Skill sources into generic runtime factories", async () => {
    const skillRoot = path.resolve("plugin-skills");
    let receivedSkillSources: readonly BackendSkillSourceContribution[] | undefined;
    const manager = new BackendPluginManager([{
      manifest: { id: "source", version: "1.0.0" },
      register(context) {
        context.skills.register(skillRoot);
        context.runtimes.register((runtimeContext) => {
          receivedSkillSources = runtimeContext.skillSources;
          return {};
        });
      },
    }]);
    await manager.register();

    const runtime = await manager.runtimeContributions().createRuntime({} as BackendPluginRuntimeContext);
    expect(receivedSkillSources).toEqual([{ pluginId: "source", root: skillRoot }]);
    runtime.dispose();
  });

  it("rolls back runtimes when a later factory fails", async () => {
    const dispose = vi.fn();
    const manager = new BackendPluginManager([
      {
        manifest: { id: "created", version: "1.0.0" },
        register: ({ runtimes }) => { runtimes.register(() => ({ dispose })); },
      },
      {
        manifest: { id: "failing", version: "1.0.0" },
        register: ({ runtimes }) => { runtimes.register(() => { throw new Error("runtime failed"); }); },
      },
    ]);
    await manager.register();

    await expect(manager.runtimeContributions().createRuntime({} as BackendPluginRuntimeContext))
      .rejects.toThrow("runtime failed");
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function plugin(id: string, events: string[], requires?: readonly string[]): BackendPlugin {
  return {
    manifest: requires ? { id, version: "1.0.0", requires } : { id, version: "1.0.0" },
    register: () => { events.push(`register:${id}`); },
    start: () => { events.push(`start:${id}`); },
    stop: () => { events.push(`stop:${id}`); },
  };
}

function routePlugin(id: string, prefix: string): BackendPlugin {
  return {
    manifest: { id, version: "1.0.0" },
    register: ({ routes }) => routes.register("tenant", prefix, async () => undefined),
  };
}
