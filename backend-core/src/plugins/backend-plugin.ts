import type { FastifyInstance } from "fastify";
import type { HookEvent, HookHandler, HookRegistry, Tool } from "@ragsystem/agent-sdk";

import type { AgentConfig } from "../contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "../contracts/runtime/path-access-policy.js";
import type { CapabilityRegistry } from "./capability-registry.js";

export type BackendRouteScope = "public" | "tenant" | "management" | "platform" | "widget";

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

export interface BackendSkillSourceContribution {
  readonly pluginId: string;
  readonly root: string;
}

export interface PluginSkillRegistrar {
  register(root: string): () => void;
}

export interface BackendToolFactoryContext {
  readonly tenantId: string;
  readonly agent: AgentConfig;
  readonly pathAccessPolicy: PathAccessPolicy;
  readonly capabilities?: CapabilityRegistry;
}

export type BackendToolFactory = (
  context: BackendToolFactoryContext,
) => Tool | readonly Tool[] | Promise<Tool | readonly Tool[]>;

export interface PluginToolRegistrar {
  register(factory: BackendToolFactory): () => void;
}

/** Immutable deployment input assembled from all registered plugins. */
export interface BackendRuntimeContributions {
  readonly skillSources: readonly BackendSkillSourceContribution[];
  isInstalled(pluginId: string): boolean;
  configureHooks(registry: HookRegistry): void;
  createTools(context: BackendToolFactoryContext): Promise<readonly Tool[]>;
}

export interface BackendPluginContext {
  readonly capabilities: CapabilityRegistry;
  readonly hooks: PluginHookRegistrar;
  readonly routes: PluginRouteRegistrar;
  readonly skills: PluginSkillRegistrar;
  readonly tools: PluginToolRegistrar;
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
