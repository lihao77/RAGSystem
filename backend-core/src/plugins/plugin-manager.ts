import type { HookEvent, HookHandler, HookRegistry, Tool } from "@ragsystem/agent-sdk";

import type {
  BackendPlugin,
  BackendPluginContext,
  BackendPluginRuntimeContext,
  BackendPluginRuntimeContribution,
  BackendPluginRuntimeFactory,
  BackendPluginRuntimeHandle,
  BackendRouteContribution,
  BackendRouteScope,
  BackendRuntimeContributions,
  BackendPluginResourceContribution,
  BackendToolFactory,
  BackendToolDescriptor,
  BackendToolFactoryContext,
  PluginRouteRegistrar,
  PluginHookRegistrar,
  PluginRuntimeRegistrar,
  PluginResourceRegistrar,
  PluginToolRegistrar,
} from "./backend-plugin.js";
import { CapabilityRegistry, provideCapability, type CapabilityProvider } from "./capability-registry.js";

class BackendRouteRegistry {
  private readonly contributions: BackendRouteContribution[] = [];
  private readonly keys = new Set<string>();

  forPlugin(pluginId: string): PluginRouteRegistrar {
    return {
      register: (scope, prefix, install) => {
        const normalizedPrefix = normalizePrefix(prefix);
        const key = `${scope}:${normalizedPrefix}`;
        if (this.keys.has(key)) {
          throw new Error(`Route contribution '${key}' is already registered`);
        }
        this.keys.add(key);
        this.contributions.push({ pluginId, scope, prefix: normalizedPrefix, install });
      },
    };
  }

  forScope(scope: BackendRouteScope): readonly BackendRouteContribution[] {
    return this.contributions.filter((contribution) => contribution.scope === scope);
  }
}

interface BackendHookContribution {
  readonly pluginId: string;
  readonly event: HookEvent;
  readonly handler: HookHandler<HookEvent>;
}

class BackendHookContributionRegistry {
  private readonly contributions: BackendHookContribution[] = [];

  forPlugin(pluginId: string): PluginHookRegistrar {
    return {
      on: <E extends HookEvent>(event: E, handler: HookHandler<E>) => {
        const contribution: BackendHookContribution = {
          pluginId,
          event,
          handler: handler as unknown as HookHandler<HookEvent>,
        };
        this.contributions.push(contribution);
        return () => {
          const index = this.contributions.indexOf(contribution);
          if (index >= 0) this.contributions.splice(index, 1);
        };
      },
    };
  }

  install(registry: HookRegistry): void {
    for (const contribution of this.contributions) {
      registry.on(contribution.event, contribution.handler);
    }
  }

  removePlugin(pluginId: string): void {
    for (let index = this.contributions.length - 1; index >= 0; index -= 1) {
      if (this.contributions[index]?.pluginId === pluginId) this.contributions.splice(index, 1);
    }
  }
}

class BackendPluginResourceRegistry {
  private readonly contributions: BackendPluginResourceContribution[] = [];

  forPlugin(pluginId: string): PluginResourceRegistrar {
    return {
      register: (kind, value) => {
        const normalizedKind = kind.trim();
        if (!normalizedKind) throw new Error("Plugin resource kind must not be empty");
        const contribution = { pluginId, kind: normalizedKind, value };
        this.contributions.push(contribution);
        return () => this.remove(contribution);
      },
    };
  }

  list(): readonly BackendPluginResourceContribution[] {
    return this.contributions.map((contribution) => ({ ...contribution }));
  }

  removePlugin(pluginId: string): void {
    for (const contribution of this.contributions.filter((item) => item.pluginId === pluginId)) {
      this.remove(contribution);
    }
  }

  private remove(contribution: BackendPluginResourceContribution): void {
    const index = this.contributions.indexOf(contribution);
    if (index < 0) return;
    this.contributions.splice(index, 1);
  }
}

interface BackendToolContribution {
  readonly pluginId: string;
  readonly factory: BackendToolFactory;
  readonly descriptors: readonly BackendToolDescriptor[];
}

class BackendToolContributionRegistry {
  private readonly contributions: BackendToolContribution[] = [];

  forPlugin(pluginId: string): PluginToolRegistrar {
    return {
      register: (factory, descriptors = []) => {
        const contribution = { pluginId, factory, descriptors };
        this.contributions.push(contribution);
        return () => {
          const index = this.contributions.indexOf(contribution);
          if (index >= 0) this.contributions.splice(index, 1);
        };
      },
    };
  }

  list(): readonly BackendToolDescriptor[] {
    return this.contributions.flatMap((contribution) => contribution.descriptors);
  }

  async create(context: BackendToolFactoryContext): Promise<readonly Tool[]> {
    const tools: Tool[] = [];
    for (const contribution of this.contributions) {
      const created = await contribution.factory(context);
      tools.push(...(Array.isArray(created) ? created : [created as Tool]));
    }
    return tools;
  }

  removePlugin(pluginId: string): void {
    for (let index = this.contributions.length - 1; index >= 0; index -= 1) {
      if (this.contributions[index]?.pluginId === pluginId) this.contributions.splice(index, 1);
    }
  }
}

interface BackendRuntimeFactoryContribution {
  readonly pluginId: string;
  readonly factory: BackendPluginRuntimeFactory;
}

class BackendRuntimeFactoryRegistry {
  private readonly contributions: BackendRuntimeFactoryContribution[] = [];

  forPlugin(pluginId: string): PluginRuntimeRegistrar {
    return {
      register: (factory) => {
        const contribution = { pluginId, factory };
        this.contributions.push(contribution);
        return () => {
          const index = this.contributions.indexOf(contribution);
          if (index >= 0) this.contributions.splice(index, 1);
        };
      },
    };
  }

  async create(context: BackendPluginRuntimeContext): Promise<BackendPluginRuntimeHandle> {
    const capabilities: CapabilityProvider[] = [];
    const runtimes: BackendPluginRuntimeContribution[] = [];
    try {
      for (const contribution of this.contributions) {
        const runtime = await contribution.factory(context);
        runtimes.push(runtime);
        for (const provider of runtime.capabilities ?? []) {
          capabilities.push(provideCapability(provider.token, provider.value, contribution.pluginId));
        }
      }
      const registry = new CapabilityRegistry(capabilities);
      let disposed = false;
      return {
        capabilities: registry,
        configureHooks(hooks) {
          for (const runtime of runtimes) runtime.configureHooks?.(hooks);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          disposePluginRuntimes(runtimes);
        },
      };
    } catch (error) {
      try {
        disposePluginRuntimes(runtimes);
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], "Plugin runtime creation and rollback failed");
      }
      throw error;
    }
  }

  removePlugin(pluginId: string): void {
    for (let index = this.contributions.length - 1; index >= 0; index -= 1) {
      if (this.contributions[index]?.pluginId === pluginId) this.contributions.splice(index, 1);
    }
  }
}

export class BackendPluginManager {
  readonly capabilities: CapabilityRegistry;
  private readonly orderedPlugins: readonly BackendPlugin[];
  private readonly routeRegistry = new BackendRouteRegistry();
  private readonly hookRegistry = new BackendHookContributionRegistry();
  private readonly resourceRegistry = new BackendPluginResourceRegistry();
  private readonly toolRegistry = new BackendToolContributionRegistry();
  private readonly runtimeFactoryRegistry = new BackendRuntimeFactoryRegistry();
  private registered = false;
  private startedPlugins: BackendPlugin[] = [];

  constructor(
    plugins: readonly BackendPlugin[] = [],
    capabilityProviders: readonly CapabilityProvider[] = [],
  ) {
    this.orderedPlugins = orderPlugins(plugins);
    this.capabilities = new CapabilityRegistry(capabilityProviders);
  }

  async register(): Promise<void> {
    if (this.registered) throw new Error("Plugins have already been registered");
    this.registered = true;
    for (const plugin of this.orderedPlugins) {
      const context: BackendPluginContext = {
        capabilities: this.capabilities,
        hooks: this.hookRegistry.forPlugin(plugin.manifest.id),
        routes: this.routeRegistry.forPlugin(plugin.manifest.id),
        runtimes: this.runtimeFactoryRegistry.forPlugin(plugin.manifest.id),
        resources: this.resourceRegistry.forPlugin(plugin.manifest.id),
        tools: this.toolRegistry.forPlugin(plugin.manifest.id),
      };
      await plugin.register(context);
    }
  }

  routes(scope: BackendRouteScope): readonly BackendRouteContribution[] {
    if (!this.registered) throw new Error("Plugins must be registered before routes are read");
    return this.routeRegistry.forScope(scope);
  }

  installHooks(registry: HookRegistry): void {
    if (!this.registered) throw new Error("Plugins must be registered before hooks are installed");
    this.hookRegistry.install(registry);
  }

  runtimeContributions(): BackendRuntimeContributions {
    if (!this.registered) throw new Error("Plugins must be registered before runtime contributions are read");
    const manager = this;
    return {
      get resources() { return manager.resourceRegistry.list(); },
      configureHooks: (registry) => manager.hookRegistry.install(registry),
      createRuntime: (context) => manager.runtimeFactoryRegistry.create({
        ...context,
        resources: [
          ...(context.resources ?? []),
          ...manager.resourceRegistry.list(),
        ],
      }),
      createTools: (context) => manager.toolRegistry.create(context),
      listTools: () => manager.toolRegistry.list(),
    };
  }

  async start(): Promise<void> {
    if (!this.registered) throw new Error("Plugins must be registered before they are started");
    if (this.startedPlugins.length > 0) throw new Error("Plugins have already been started");
    try {
      for (const plugin of this.orderedPlugins) {
        this.startedPlugins.push(plugin);
        await plugin.start?.();
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const plugins = this.startedPlugins.reverse();
    this.startedPlugins = [];
    const errors: unknown[] = [];
    for (const plugin of plugins) {
      try {
        await plugin.stop?.();
      } catch (error) {
        errors.push(error);
      } finally {
        this.hookRegistry.removePlugin(plugin.manifest.id);
        this.runtimeFactoryRegistry.removePlugin(plugin.manifest.id);
        this.resourceRegistry.removePlugin(plugin.manifest.id);
        this.toolRegistry.removePlugin(plugin.manifest.id);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "One or more plugins failed to stop");
  }
}

function disposePluginRuntimes(runtimes: readonly BackendPluginRuntimeContribution[]): void {
  const errors: unknown[] = [];
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    try {
      runtimes[index]?.dispose?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "One or more plugin runtimes failed to dispose");
}

function orderPlugins(plugins: readonly BackendPlugin[]): readonly BackendPlugin[] {
  const byId = new Map<string, BackendPlugin>();
  for (const plugin of plugins) {
    const id = plugin.manifest.id.trim();
    if (!id) throw new Error("Plugin id must not be empty");
    if (byId.has(id)) throw new Error(`Plugin '${id}' is installed more than once`);
    byId.set(id, plugin);
  }

  const ordered: BackendPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle includes '${id}'`);
    const plugin = byId.get(id);
    if (!plugin) throw new Error(`Required plugin '${id}' is not installed`);
    visiting.add(id);
    for (const dependency of plugin.manifest.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(plugin);
  };
  for (const id of byId.keys()) visit(id);
  return ordered;
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim();
  if (!normalized.startsWith("/")) throw new Error(`Plugin route prefix must start with '/': ${prefix}`);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
