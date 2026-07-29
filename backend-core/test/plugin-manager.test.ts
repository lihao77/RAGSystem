import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  BackendPlugin,
  BackendPluginResourceContribution,
  BackendPluginRuntimeContext,
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

  it("injects opaque plugin resources into generic runtime factories", async () => {
    const skillRoot = path.resolve("plugin-skills");
    let receivedResources: readonly BackendPluginResourceContribution[] | undefined;
    const manager = new BackendPluginManager([{
      manifest: { id: "source", version: "1.0.0" },
      register(context) {
        context.resources.register("ragsystem.skill-source", skillRoot);
        context.runtimes.register((runtimeContext) => {
          receivedResources = runtimeContext.resources;
          return {};
        });
      },
    }]);
    await manager.register();

    const runtime = await manager.runtimeContributions().createRuntime({} as BackendPluginRuntimeContext);
    expect(receivedResources).toEqual([{
      pluginId: "source",
      kind: "ragsystem.skill-source",
      value: skillRoot,
    }]);
    runtime.dispose();
  });

  it("merges deployment host resources into application and tenant runtime factories", async () => {
    const hostResource: BackendPluginResourceContribution = {
      pluginId: "host",
      kind: "ragsystem.host.database.runtime",
      value: { query: vi.fn() },
    };
    let applicationResources: readonly BackendPluginResourceContribution[] | undefined;
    let runtimeResources: readonly BackendPluginResourceContribution[] | undefined;
    const manager = new BackendPluginManager([{
      manifest: { id: "consumer", version: "1.0.0" },
      register(context) {
        context.applications.register((applicationContext) => {
          applicationResources = applicationContext.resources;
          return {};
        });
        context.runtimes.register((runtimeContext) => {
          runtimeResources = runtimeContext.resources;
          return {};
        });
      },
    }]);
    await manager.register();
    await manager.initializeApplication({ logger: {} as never, registry: {} as never, resources: [hostResource] });
    const contributions = manager.runtimeContributions([hostResource]);
    const runtime = await contributions.createRuntime({} as BackendPluginRuntimeContext);

    expect(contributions.resources).toEqual([hostResource]);
    expect(applicationResources).toEqual([hostResource]);
    expect(runtimeResources).toEqual([hostResource]);
    runtime.dispose();
    await manager.stop();
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

  it("owns process-level application runtimes and dispatches generic events", async () => {
    const events: string[] = [];
    const manager = new BackendPluginManager([{
      manifest: { id: "application", version: "1.0.0" },
      register(context) {
        context.applications.register(() => {
          events.push("create:application");
          return {
            start: () => { events.push("start:application"); },
            dispose: () => { events.push("dispose:application"); },
          };
        });
        context.events.on("resource.changed", (payload) => {
          events.push(`event:${String((payload as { id?: unknown }).id)}`);
        });
      },
      start: () => { events.push("start:plugin"); },
      stop: () => { events.push("stop:plugin"); },
    }]);

    await manager.register();
    await manager.initializeApplication({} as never);
    await manager.start();
    await manager.emit("resource.changed", { id: "bot-a" });
    await manager.stop();

    expect(events).toEqual([
      "create:application",
      "start:application",
      "start:plugin",
      "event:bot-a",
      "stop:plugin",
      "dispose:application",
    ]);
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
