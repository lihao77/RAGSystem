import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { HookEvent, HookHandler, HookRegistry, Tool } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../contracts/agent/agent-config.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import type { PathAccessPolicy } from "../contracts/runtime/path-access-policy.js";
import type { TenantId } from "../identity/types.js";
import type { AgentConfigService } from "../services/agent/config/index.js";
import type { ModelAdapterService } from "../services/integrations/model-adapter-service.js";
import type { SystemConfigService } from "../services/config/system-config-service.js";
import type { BackgroundTaskService } from "../services/runtime/background-task-service.js";
import type { ClientEventPublisherPort } from "../contracts/runtime/core-runtime-ports.js";
import type { CapabilityProvider, CapabilityRegistry } from "./capability-registry.js";
import type { RuntimeContainerRegistry } from "../services/runtime/runtime-container-registry.js";

export type BackendRouteScope = "public" | "tenant" | "management" | "platform";

export type BackendRouteInstaller = (app: FastifyInstance) => Promise<void>;

export interface BackendRouteContribution {
  readonly pluginId: string;
  readonly scope: BackendRouteScope;
  readonly prefix: string;
  readonly install: BackendRouteInstaller;
}

export interface PluginRouteRegistrar {
  register(scope: BackendRouteScope, prefix: string, install: BackendRouteInstaller): void;
}

/** Registers handlers that are installed into every per-run SDK hook registry. */
export interface PluginHookRegistrar {
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void;
}

export type BackendApplicationEventHandler = (payload: unknown) => void | Promise<void>;

export interface PluginEventRegistrar {
  on(event: string, handler: BackendApplicationEventHandler): () => void;
}

export interface BackendPluginResourceContribution {
  readonly pluginId: string;
  readonly kind: string;
  readonly value: unknown;
}

export interface PluginResourceRegistrar {
  register(kind: string, value: unknown): () => void;
}

export interface BackendToolFactoryContext {
  readonly tenantId: string;
  readonly teamName: string | null;
  readonly agent: AgentConfig;
  readonly pathAccessPolicy: PathAccessPolicy;
  readonly capabilities?: CapabilityRegistry;
  readonly callTool?: (
    toolName: string,
    args: Record<string, unknown>,
    context: import("@ragsystem/agent-sdk").ToolExecContext,
  ) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
}

export interface BackendToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly risk_level: "low" | "medium" | "high";
}

export type BackendToolFactory = (
  context: BackendToolFactoryContext,
) => Tool | readonly Tool[] | Promise<Tool | readonly Tool[]>;

export interface PluginToolRegistrar {
  register(factory: BackendToolFactory, descriptors?: readonly BackendToolDescriptor[]): () => void;
}

export interface BackendPluginRuntimeContext {
  readonly deploymentKind: "local" | "saas";
  readonly tenantId: TenantId;
  readonly dataRoot: string;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly agentConfig: AgentConfigService;
  readonly sessions: SessionApplication;
  readonly backgroundTasks: BackgroundTaskService;
  readonly clientEvents: ClientEventPublisherPort;
  readonly resources?: readonly BackendPluginResourceContribution[];
}

export interface BackendPluginRuntimeContribution {
  readonly capabilities?: readonly CapabilityProvider[];
  configureHooks?(registry: HookRegistry): void;
  dispose?(): void;
}

export type BackendPluginRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => BackendPluginRuntimeContribution | Promise<BackendPluginRuntimeContribution>;

export interface PluginRuntimeRegistrar {
  register(factory: BackendPluginRuntimeFactory): () => void;
}

export interface BackendPluginApplicationContext {
  readonly logger: FastifyBaseLogger;
  readonly registry: RuntimeContainerRegistry;
  readonly resources?: readonly BackendPluginResourceContribution[];
}

export interface BackendPluginApplicationContribution {
  start?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type BackendPluginApplicationFactory = (
  context: BackendPluginApplicationContext,
) => BackendPluginApplicationContribution | Promise<BackendPluginApplicationContribution>;

export interface PluginApplicationRegistrar {
  register(factory: BackendPluginApplicationFactory): () => void;
}

export interface BackendPluginRuntimeHandle {
  readonly capabilities: CapabilityRegistry;
  configureHooks(registry: HookRegistry): void;
  dispose(): void;
}

/** Immutable deployment input assembled from all registered plugins. */
export interface BackendRuntimeContributions {
  readonly resources: readonly BackendPluginResourceContribution[];
  configureHooks(registry: HookRegistry): void;
  createRuntime(context: BackendPluginRuntimeContext): Promise<BackendPluginRuntimeHandle>;
  createTools(context: BackendToolFactoryContext): Promise<readonly Tool[]>;
  listTools(): readonly BackendToolDescriptor[];
}

export interface BackendPluginContext {
  readonly capabilities: CapabilityRegistry;
  readonly hooks: PluginHookRegistrar;
  readonly routes: PluginRouteRegistrar;
  readonly runtimes: PluginRuntimeRegistrar;
  readonly resources: PluginResourceRegistrar;
  readonly tools: PluginToolRegistrar;
  readonly applications: PluginApplicationRegistrar;
  readonly events: PluginEventRegistrar;
}

export interface BackendPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly string[];
}

export interface BackendPlugin {
  readonly manifest: BackendPluginManifest;
  register(context: BackendPluginContext): void | Promise<void>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}
