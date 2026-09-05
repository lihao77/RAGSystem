import type { FastifyBaseLogger } from "fastify";
import type { HookEvent, HookHandler, HookRegistry, Tool } from "@ragsystem/agent-sdk";
import type { MessageContentPart } from "@ragsystem/agent-protocol";

import type {
  BackendPlugin,
  BackendApplicationEventHandler,
  BackendPluginApplicationContext,
  BackendPluginApplicationContribution,
  BackendPluginApplicationFactory,
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
  PluginApplicationRegistrar,
  PluginEventRegistrar,
  PluginRuntimeRegistrar,
  PluginResourceRegistrar,
  PluginToolRegistrar,
  PluginUserMessageTransformerRegistrar,
  PluginUiRegistrar,
  PluginUiManifest,
  BackendUiContribution,
  UserMessageTransformInput,
  UserMessageTransformer,
} from "./backend-plugin.js";
import { CapabilityRegistry, provideCapability, type CapabilityProvider } from "./capability-registry.js";
import { createPluginClientEventPublisher } from "./plugin-event-publisher.js";
import { registerRetiredToolNames } from "../contracts/agent/tool-name-aliases.js";
import type { BackendResourceToken } from "./resource-registry.js";

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

class BackendUiRegistry {
  private readonly contributions: BackendUiContribution[] = [];

  forPlugin(pluginId: string): PluginUiRegistrar {
    return {
      register: (manifest) => {
        validateUiManifest(manifest);
        const contribution: BackendUiContribution = { pluginId, manifest };
        this.contributions.push(contribution);
        return () => {
          const index = this.contributions.indexOf(contribution);
          if (index >= 0) this.contributions.splice(index, 1);
        };
      },
    };
  }

  list(): readonly BackendUiContribution[] {
    return this.contributions.map((contribution) => ({
      pluginId: contribution.pluginId,
      manifest: structuredClone(contribution.manifest),
    }));
  }

  removePlugin(pluginId: string): void {
    for (let index = this.contributions.length - 1; index >= 0; index -= 1) {
      if (this.contributions[index]?.pluginId === pluginId) this.contributions.splice(index, 1);
    }
  }
}

function validateUiManifest(manifest: PluginUiManifest): void {
  if (!manifest.bundleUrl.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(manifest.bundleUrl)) {
    throw new Error(`Plugin UI bundleUrl must be a same-origin path starting with '/': ${manifest.bundleUrl}`);
  }
  if (manifest.views.length === 0) {
    throw new Error("Plugin UI manifest must declare at least one view");
  }
  for (const view of manifest.views) {
    if (!view.route.startsWith("/")) {
      throw new Error(`Plugin UI view route must start with '/': ${view.route}`);
    }
    if (!view.entry.trim()) {
      throw new Error(`Plugin UI view entry must not be empty (route '${view.route}')`);
    }
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

interface BackendApplicationEventContribution {
  readonly pluginId: string;
  readonly event: string;
  readonly handler: BackendApplicationEventHandler;
}

class BackendApplicationEventRegistry {
  private readonly contributions: BackendApplicationEventContribution[] = [];

  /** 宿主注入的错误记录器：单个 handler 失败只记日志，不中断其余订阅方。 */
  private handlerError: ((pluginId: string, event: string, error: unknown) => void) | null = null;

  setHandlerErrorReporter(reporter: (pluginId: string, event: string, error: unknown) => void): void {
    this.handlerError = reporter;
  }

  forPlugin(pluginId: string): PluginEventRegistrar {
    return {
      on: (event, handler) => {
        const normalizedEvent = event.trim();
        if (!normalizedEvent) throw new Error("Plugin application event must not be empty");
        const contribution = { pluginId, event: normalizedEvent, handler };
        this.contributions.push(contribution);
        return () => this.remove(contribution);
      },
    };
  }

  async emit(event: string, payload: unknown): Promise<void> {
    for (const contribution of this.contributions) {
      if (contribution.event !== event) continue;
      try {
        await contribution.handler(payload);
      } catch (error) {
        // 事件是尽力通知：订阅方异常不影响发布方（如实体删除）已提交的变更。
        this.handlerError?.(contribution.pluginId, event, error);
      }
    }
  }

  removePlugin(pluginId: string): void {
    for (const contribution of this.contributions.filter((item) => item.pluginId === pluginId)) {
      this.remove(contribution);
    }
  }

  private remove(contribution: BackendApplicationEventContribution): void {
    const index = this.contributions.indexOf(contribution);
    if (index >= 0) this.contributions.splice(index, 1);
  }
}

class BackendPluginResourceRegistry {
  private readonly contributions: BackendPluginResourceContribution[] = [];

  forPlugin(pluginId: string): PluginResourceRegistrar {
    return {
      register: <Value>(token: BackendResourceToken<Value>, value: Value) => {
        const contribution = { providerId: pluginId, token, value };
        this.contributions.push(contribution);
        return () => this.remove(contribution);
      },
    };
  }

  list(): readonly BackendPluginResourceContribution[] {
    return this.contributions.map((contribution) => ({ ...contribution }));
  }

  removePlugin(pluginId: string): void {
    for (const contribution of this.contributions.filter((item) => item.providerId === pluginId)) {
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
        // 工具历史名是插件知识：随描述符声明灌入注册表，配置/快照归一层消费。
        // 只增不删——退役名是历史事实，注销（下方 dispose）不回收。
        for (const descriptor of descriptors) {
          if (descriptor.retired_names?.length) {
            registerRetiredToolNames(descriptor.name, descriptor.retired_names);
          }
        }
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
      // 有 clientEvents 时按插件盖章注入 pluginEvents（工具可向会话推 plugin_event 帧）。
      const scopedContext = context.clientEvents
        ? { ...context, pluginEvents: createPluginClientEventPublisher(contribution.pluginId, context.clientEvents) }
        : context;
      const created = await contribution.factory(scopedContext);
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

interface BackendUserMessageTransformerContribution {
  readonly pluginId: string;
  readonly transformer: UserMessageTransformer;
}

/**
 * 用户消息持久化前变换管道。
 *
 * 顺序 await 所有 transformer，后一个接收前一个的输出（contentParts 更新后的输入）；
 * 单个 transformer 返回 null/undefined 表示不变；单个 handler 异常 catch 不阻断管道。
 */
class BackendUserMessageTransformerRegistry {
  private readonly contributions: BackendUserMessageTransformerContribution[] = [];

  forPlugin(pluginId: string): PluginUserMessageTransformerRegistrar {
    return {
      register: (transformer) => {
        const contribution = { pluginId, transformer };
        this.contributions.push(contribution);
        return () => {
          const index = this.contributions.indexOf(contribution);
          if (index >= 0) this.contributions.splice(index, 1);
        };
      },
    };
  }

  async transform(input: UserMessageTransformInput): Promise<MessageContentPart[] | null> {
    let contentParts: MessageContentPart[] | null = null;
    for (const contribution of this.contributions) {
      try {
        const current = contentParts ?? [...input.contentParts];
        // 有 clientEvents 时按插件盖章注入 pluginEvents（变换期间可推 plugin_event 进度帧）。
        const scopedInput = input.clientEvents
          ? { ...input, contentParts: current, pluginEvents: createPluginClientEventPublisher(contribution.pluginId, input.clientEvents) }
          : { ...input, contentParts: current };
        const result = await contribution.transformer(scopedInput);
        if (result) contentParts = result;
      } catch {
        // 单个 transformer 失败不影响消息发送与其余管道（保持当前内容不变）。
      }
    }
    return contentParts;
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
        // 有 clientEvents 时按插件盖章注入 pluginEvents：plugin_id 取自注册 contribution，插件不可伪造。
        const runtime = await contribution.factory(
          context.clientEvents
            ? { ...context, pluginEvents: createPluginClientEventPublisher(contribution.pluginId, context.clientEvents) }
            : context,
        );
        runtimes.push(runtime);
        for (const provider of runtime.capabilities ?? []) {
          capabilities.push(provideCapability(provider.token, provider.value, contribution.pluginId));
        }
      }
      const registry = new CapabilityRegistry(capabilities);
      const contextSources = runtimes.flatMap((runtime) => runtime.contextSources ?? []);
      let disposed = false;
      return {
        capabilities: registry,
        configureHooks(hooks) {
          for (const runtime of runtimes) runtime.configureHooks?.(hooks);
        },
        contextSources,
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

interface BackendApplicationFactoryContribution {
  readonly pluginId: string;
  readonly factory: BackendPluginApplicationFactory;
}

interface BackendPluginApplicationRuntimeHandle {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

class BackendApplicationFactoryRegistry {
  private readonly contributions: BackendApplicationFactoryContribution[] = [];

  forPlugin(pluginId: string): PluginApplicationRegistrar {
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

  async create(context: BackendPluginApplicationContext): Promise<BackendPluginApplicationRuntimeHandle> {
    const runtimes: BackendPluginApplicationContribution[] = [];
    try {
      for (const contribution of this.contributions) runtimes.push(await contribution.factory(context));
    } catch (error) {
      await disposeApplicationRuntimes(runtimes);
      throw error;
    }
    let started = false;
    let disposed = false;
    return {
      async start() {
        if (started) return;
        started = true;
        try {
          for (const runtime of runtimes) {
            await runtime.start?.();
          }
        } catch (error) {
          await disposeApplicationRuntimes(runtimes);
          disposed = true;
          throw error;
        }
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await disposeApplicationRuntimes(runtimes);
      },
    };
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
  private readonly applicationFactoryRegistry = new BackendApplicationFactoryRegistry();
  private readonly applicationEventRegistry = new BackendApplicationEventRegistry();
  private readonly userMessageTransformerRegistry = new BackendUserMessageTransformerRegistry();
  private readonly uiRegistry = new BackendUiRegistry();
  private registered = false;
  private startedPlugins: BackendPlugin[] = [];
  private applicationRuntime: BackendPluginApplicationRuntimeHandle | null = null;

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
        applications: this.applicationFactoryRegistry.forPlugin(plugin.manifest.id),
        events: this.applicationEventRegistry.forPlugin(plugin.manifest.id),
        transformers: this.userMessageTransformerRegistry.forPlugin(plugin.manifest.id),
        ui: this.uiRegistry.forPlugin(plugin.manifest.id),
      };
      await plugin.register(context);
    }
  }

  async initializeApplication(context: BackendPluginApplicationContext): Promise<void> {
    if (!this.registered) throw new Error("Plugins must be registered before application runtimes are initialized");
    if (this.applicationRuntime) throw new Error("Plugin application runtimes have already been initialized");
    this.applicationEventRegistry.setHandlerErrorReporter((pluginId, event, error) => {
      context.logger.error({ err: error, pluginId, event }, "Plugin application event handler failed");
    });
    this.applicationRuntime = await this.applicationFactoryRegistry.create({
      ...context,
      resources: [
        ...(context.resources ?? []),
        ...this.resourceRegistry.list(),
      ],
    });
  }

  emit(event: string, payload: unknown): Promise<void> {
    if (!this.registered) throw new Error("Plugins must be registered before application events are emitted");
    return this.applicationEventRegistry.emit(event, payload);
  }

  transformUserMessage(input: UserMessageTransformInput): Promise<MessageContentPart[] | null> {
    if (!this.registered) throw new Error("Plugins must be registered before user messages are transformed");
    return this.userMessageTransformerRegistry.transform(input);
  }

  routes(scope: BackendRouteScope): readonly BackendRouteContribution[] {
    if (!this.registered) throw new Error("Plugins must be registered before routes are read");
    return this.routeRegistry.forScope(scope);
  }

  /** 已注册插件的 UI 清单（深拷贝，含宿主盖章的 pluginId）。 */
  listUi(): readonly BackendUiContribution[] {
    if (!this.registered) throw new Error("Plugins must be registered before UI manifests are read");
    return this.uiRegistry.list();
  }

  /** 已注册插件的基本信息（id/version），供插件清单端点使用。 */
  listPlugins(): readonly { id: string; version: string }[] {
    if (!this.registered) throw new Error("Plugins must be registered before plugins are listed");
    return this.orderedPlugins.map((plugin) => ({ id: plugin.manifest.id, version: plugin.manifest.version }));
  }

  installHooks(registry: HookRegistry): void {
    if (!this.registered) throw new Error("Plugins must be registered before hooks are installed");
    this.hookRegistry.install(registry);
  }

  runtimeContributions(hostResources: readonly BackendPluginResourceContribution[] = []): BackendRuntimeContributions {
    if (!this.registered) throw new Error("Plugins must be registered before runtime contributions are read");
    const manager = this;
    return {
      get resources() { return [...hostResources, ...manager.resourceRegistry.list()]; },
      configureHooks: (registry) => manager.hookRegistry.install(registry),
      createRuntime: (context) => manager.runtimeFactoryRegistry.create({
        ...context,
        listPluginTools: () => manager.toolRegistry.list(),
        resources: [
          ...(context.resources ?? []),
          ...hostResources,
          ...manager.resourceRegistry.list(),
        ],
      }),
      createTools: (context) => manager.toolRegistry.create(context),
      listTools: () => manager.toolRegistry.list(),
      transformUserMessage: (input) => manager.transformUserMessage(input),
    };
  }

  async start(): Promise<void> {
    if (!this.registered) throw new Error("Plugins must be registered before they are started");
    if (this.startedPlugins.length > 0) throw new Error("Plugins have already been started");
    try {
      await this.applicationRuntime?.start();
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
        this.applicationFactoryRegistry.removePlugin(plugin.manifest.id);
        this.applicationEventRegistry.removePlugin(plugin.manifest.id);
        this.userMessageTransformerRegistry.removePlugin(plugin.manifest.id);
        this.uiRegistry.removePlugin(plugin.manifest.id);
      }
    }
    try {
      await this.applicationRuntime?.dispose();
    } catch (error) {
      errors.push(error);
    } finally {
      this.applicationRuntime = null;
    }
    if (errors.length > 0) throw new AggregateError(errors, "One or more plugins failed to stop");
  }
}

async function disposeApplicationRuntimes(runtimes: readonly BackendPluginApplicationContribution[]): Promise<void> {
  const errors: unknown[] = [];
  for (let index = runtimes.length - 1; index >= 0; index -= 1) {
    try {
      await runtimes[index]?.dispose?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "One or more plugin application runtimes failed to dispose");
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
