import type { HookEvent, HookHandler, HookRegistry } from "@ragsystem/agent-sdk";

import type {
  BackendPlugin,
  BackendPluginContext,
  BackendRouteContribution,
  BackendRouteScope,
  PluginRouteRegistrar,
  PluginHookRegistrar,
} from "./backend-plugin.js";
import { CapabilityRegistry, type CapabilityProvider } from "./capability-registry.js";

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

export class BackendPluginManager {
  readonly capabilities: CapabilityRegistry;
  private readonly orderedPlugins: readonly BackendPlugin[];
  private readonly routeRegistry = new BackendRouteRegistry();
  private readonly hookRegistry = new BackendHookContributionRegistry();
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
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "One or more plugins failed to stop");
  }
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
